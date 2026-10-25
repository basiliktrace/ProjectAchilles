package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/clerkkey"
	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
)

// probeTimeout bounds the Frontend API reachability check.
const probeTimeout = 5 * time.Second

type loginStep int

const (
	loginKeys loginStep = iota // publishable + secret key
	loginDNS                   // production keys: confirm Clerk's DNS records
)

// loginScreen collects the Clerk keys. clerkkey.CheckFit runs live: an
// error finding blocks Next, a warning doesn't. The decoded Frontend API
// host is probed for reachability (warn only).
type loginScreen struct {
	s    *shared
	step loginStep
	form *huh.Form

	pk, sk    string
	admin     string // first admin's email (optional)
	attempted bool   // the admin pressed enter on the secret key
	dnsAnswer string // loginDNS: yes | later

	probeHost string // host the probe below belongs to
	probing   bool
	probeErr  error
}

type clerkProbeMsg struct {
	host string
	err  error
}

func newLogin(s *shared) *loginScreen { return &loginScreen{s: s} }

func (l *loginScreen) Title() string { return "Login (Clerk)" }

func (l *loginScreen) Help() string {
	if l.step == loginDNS {
		return "↑/↓ choose · enter next · esc back · ctrl+c quit"
	}
	return "enter next field · shift+tab previous · esc back · ctrl+c quit"
}

func (l *loginScreen) Init() tea.Cmd {
	l.pk, l.sk, l.admin = l.s.cfg.ClerkPublishableKey, l.s.cfg.ClerkSecretKey, l.s.cfg.AdminEmail
	l.attempted = false
	return tea.Batch(l.toKeys(), l.maybeProbe())
}

func (l *loginScreen) toKeys() tea.Cmd {
	l.step = loginKeys
	var cmd tea.Cmd
	l.form, cmd = l.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Clerk publishable key").
			Placeholder("pk_live_… or pk_test_…").
			Value(&l.pk).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return errors.New("required")
				}
				if _, err := clerkkey.DecodePublishable(v); err != nil {
					return errors.New("not a valid publishable key (see below)")
				}
				return nil
			}),
		huh.NewInput().
			Title("Clerk secret key").
			Placeholder("sk_live_… or sk_test_…").
			EchoMode(huh.EchoModePassword).
			Value(&l.sk).
			Validate(func(string) error {
				l.attempted = true
				if hasError(l.findings()) {
					return errors.New("fix the problem shown below first")
				}
				return nil
			}),
		huh.NewInput().
			// No description: at 80x24 a blocking key error must stay visible below.
			Title("First admin email (optional: invited as admin)").
			Placeholder("you@example.com, or blank if the Clerk app has an admin").
			Value(&l.admin).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return nil
				}
				return validEmail(v)
			}),
	))
	return cmd
}

func (l *loginScreen) toDNS() tea.Cmd {
	l.step = loginDNS
	l.dnsAnswer = "yes"
	var cmd tea.Cmd
	l.form, cmd = l.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Have you published the DNS records Clerk lists?").
			Options(
				huh.NewOption("Yes, they're published (Clerk shows them verified)", "yes"),
				huh.NewOption("Not yet: continue (sign-in fails until they are)", "later"),
			).
			Value(&l.dnsAnswer),
	))
	return cmd
}

// findings is CheckFit for the current input. "Required" findings wait
// until the admin has tried to continue, so an empty form isn't all red.
func (l *loginScreen) findings() []clerkkey.Finding {
	all := clerkkey.CheckFit(l.pk, l.sk, l.s.class)
	if l.attempted {
		return all
	}
	var out []clerkkey.Finding
	for _, f := range all {
		if !strings.Contains(f.Message, "is required") {
			out = append(out, f)
		}
	}
	return out
}

func hasError(fs []clerkkey.Finding) bool {
	for _, f := range fs {
		if f.Severity == "error" {
			return true
		}
	}
	return false
}

// fapi is the decoded Frontend API host, or "".
func (l *loginScreen) fapi() (clerkkey.Key, bool) {
	k, err := clerkkey.DecodePublishable(l.pk)
	return k, err == nil
}

// maybeProbe starts a reachability check when the decoded host changed.
func (l *loginScreen) maybeProbe() tea.Cmd {
	k, ok := l.fapi()
	if !ok || k.FAPIHost == l.probeHost || l.s.deps.System == nil {
		return nil
	}
	l.probeHost, l.probing, l.probeErr = k.FAPIHost, true, nil
	host, sys := k.FAPIHost, l.s.deps.System
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
		defer cancel()
		return clerkProbeMsg{host: host, err: sys.HTTPReachable(ctx, "https://"+host+"/v1/environment")}
	}
}

func (l *loginScreen) Back() (bool, tea.Cmd) {
	if l.step == loginDNS {
		return true, l.toKeys()
	}
	return false, nil
}

func (l *loginScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m, ok := msg.(clerkProbeMsg); ok {
		if m.host == l.probeHost {
			l.probing, l.probeErr = false, m.err
		}
		return l, nil
	}
	completed, cmd := updateForm(l.form, msg)
	if l.step == loginKeys {
		cmd = tea.Batch(cmd, l.maybeProbe())
	}
	if !completed {
		return l, cmd
	}
	switch l.step {
	case loginKeys:
		l.pk, l.sk, l.admin = strings.TrimSpace(l.pk), strings.TrimSpace(l.sk), strings.TrimSpace(l.admin)
		if k, ok := l.fapi(); ok && k.Live {
			return l, tea.Batch(cmd, l.toDNS())
		}
		return l, tea.Batch(cmd, done(l))
	default:
		return l, tea.Batch(cmd, done(l))
	}
}

func (l *loginScreen) View() tea.View {
	t := l.s.theme
	w := l.s.width - 2
	var b strings.Builder
	if l.step == loginDNS {
		k, _ := l.fapi()
		b.WriteString(wrap(fmt.Sprintf("This production app's Frontend API is %s. Clerk's dashboard (Domains) lists DNS records (CNAMEs) for it to add to your public zone; sign-in fails until Clerk has verified them.", t.Strong.Render(k.FAPIHost)), l.s.width) + "\n\n")
		b.WriteString(l.probeLine() + "\n\n")
		b.WriteString(l.form.View())
		return tea.NewView(b.String())
	}
	b.WriteString(t.Muted.Render(wrap(l.helpText(), l.s.width)) + "\n\n")
	b.WriteString(l.form.View() + "\n\n")
	if line := l.probeLine(); line != "" {
		b.WriteString(line + "\n")
	}
	for _, f := range l.findings() {
		if f.Severity == "error" {
			b.WriteString(t.bad(wrap(f.Message, w)) + "\n")
		} else {
			b.WriteString(t.warn(wrap(f.Message, w)) + "\n")
		}
	}
	return tea.NewView(strings.TrimRight(b.String(), "\n"))
}

// helpText explains which Clerk keys fit this server name.
func (l *loginScreen) helpText() string {
	host := l.s.cfg.AchillesDomain
	if l.s.class.Kind == dnsclass.PublicDomain {
		return fmt.Sprintf("Create an app at dashboard.clerk.com and copy both keys from API Keys. For %s use production keys (pk_live_) from an app on that name or a parent domain. Development keys (pk_test_) are free and work too, but show a \"Development mode\" banner and have lower usage limits.", host)
	}
	return fmt.Sprintf("Create an app at dashboard.clerk.com and copy both keys from API Keys. %s is private-only, so use development keys (pk_test_): they are free but show a \"Development mode\" banner and have lower usage limits.", host)
}

// probeLine reports the Frontend API host and whether this server reaches it.
func (l *loginScreen) probeLine() string {
	t := l.s.theme
	k, ok := l.fapi()
	if !ok {
		return ""
	}
	head := "Frontend API: " + k.FAPIHost
	switch {
	case k.FAPIHost != l.probeHost || l.probing:
		return t.Muted.Render(head + " · checking reachability…")
	case l.probeErr != nil:
		return t.warn(wrap(head+" is not reachable from this server ("+l.probeErr.Error()+"). This only warns: browsers need to reach it, not the server.", l.s.width-2))
	default:
		return t.ok(head + " · reachable from this server")
	}
}

// Apply stores the keys and the first admin.
func (l *loginScreen) Apply(c *config.Config) {
	c.ClerkPublishableKey, c.ClerkSecretKey, c.AdminEmail = l.pk, l.sk, l.admin
}

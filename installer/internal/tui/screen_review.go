package tui

import (
	"fmt"
	"path/filepath"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/clerkkey"
	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
)

// reviewScreen shows every answer (secrets masked) and, once the admin
// confirms, writes deploy.config.env (mode 0600). It is the wizard's only
// point of no return: nothing before it changes the server.
type reviewScreen struct {
	s      *shared
	form   *huh.Form
	ok     bool
	scroll scroller

	problems []config.Problem
	writeErr error
}

func newReview(s *shared) *reviewScreen { return &reviewScreen{s: s} }

func (r *reviewScreen) Title() string { return "Review" }

func (r *reviewScreen) Help() string {
	h := "←/→ choose · enter confirm · esc back · ctrl+c quit"
	if r.scroll.scrollable() {
		h = "↑/↓ scroll · " + h
	}
	return h
}

func (r *reviewScreen) Init() tea.Cmd {
	r.writeErr = nil
	r.problems = r.s.cfg.Validate()
	r.ok = true
	r.scroll = scroller{}
	var cmd tea.Cmd
	r.form, cmd = r.s.newForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Write the settings and install?").
			Description("Nothing has been written yet. Yes saves " + filepath.Base(r.s.deps.ConfigPath) + " and starts the install.").
			Affirmative("Yes, install").
			Negative("Go back").
			Value(&r.ok),
	))
	r.layout()
	return cmd
}

// installerBin is where install-onprem.sh puts the binary.
func (r *reviewScreen) installerBin() string {
	return filepath.Join(r.s.deps.RepoRoot, "achilles-installer")
}

// commandLines is the unattended equivalent, split with shell line
// continuations to fit width.
func (r *reviewScreen) commandLines(width int) []string {
	return shellLines([]string{"sudo", r.installerBin(), "install", "--config", r.s.deps.ConfigPath, "--yes"}, width)
}

// shellLines packs words into lines of at most width cells, ending every
// line but the last with " \" and indenting continuations by two spaces,
// so the result still pastes as one command.
func shellLines(words []string, width int) []string {
	var lines []string
	cur := ""
	for _, w := range words {
		switch {
		case cur == "":
			cur = w
		case lipgloss.Width(cur+" "+w+" \\") <= width:
			cur += " " + w
		default:
			lines = append(lines, cur+" \\")
			cur = "  " + w
		}
	}
	return append(lines, cur)
}

func (r *reviewScreen) rows() []string {
	t := r.s.theme
	c := r.s.cfg
	const labelW = 14
	var out []string
	row := func(label, val string) {
		out = append(out, t.Muted.Render(fmt.Sprintf("%-*s", labelW, label))+val)
	}

	server := c.AchillesDomain
	if ip := strings.Trim(c.CaddyBindIP, "[]"); ip != "" {
		server += " → " + ip
	}
	if c.LANSubnets != "" {
		server += " · LAN " + c.LANSubnets
	}
	row("Server", server)
	if c.HostsEntry {
		row("", "adds an /etc/hosts entry for it on this server")
	}

	switch c.TLSMode {
	case "achilles-ca":
		ip := "no IP addresses"
		if c.CAIncludeIP {
			ip = "LAN IP allowed"
		}
		v := "ProjectAchilles CA · zone " + c.CAZone + " · " + ip
		row("Certificates", v)
		if c.CARotate {
			row("", t.Warn.Render("! rotate the root CA: every endpoint must re-trust it"))
		}
	case "byo":
		row("Certificates", "Your certificate: deploy/caddy/certs/cert.pem + key.pem")
	case "acme-dns":
		row("Certificates", "Let's Encrypt DNS-01 via "+c.CaddyDNSProvider+" · "+c.ACMEEmail)
		row("", "DNS API token "+mask(c.CaddyDNSToken))
	case "internal":
		row("Certificates", "Caddy internal CA (distribute its root yourself)")
	default:
		row("Certificates", "Let's Encrypt HTTP-01 · "+c.ACMEEmail)
	}

	clerk := "(not set)"
	if k, err := clerkkey.DecodePublishable(c.ClerkPublishableKey); err == nil {
		env := "development"
		if k.Live {
			env = "production"
		}
		clerk = fmt.Sprintf("%s key for %s (%s)", c.ClerkPublishableKey[:8], k.FAPIHost, env)
	}
	row("Clerk", clerk)
	row("", "secret key "+mask(c.ClerkSecretKey))

	if c.ESMode == "cloud" {
		row("Analytics", "Elastic Cloud · "+c.ElasticsearchCloudID)
		row("", "API key "+mask(c.ElasticsearchAPIKey))
	} else {
		seed := "no"
		if c.SeedES == "true" {
			seed = "yes"
		}
		row("Analytics", "Self-hosted Elasticsearch · demo data: "+seed)
	}

	row("Organisation", orDefault(c.OrganizationName, "(none: reports say \"All organizations\")"))
	row("Test library", c.TestsRepoURL+" ("+c.TestsRepoBranch+")")
	token := "none"
	if c.GithubToken != "" {
		token = mask(c.GithubToken)
	}
	row("", "GitHub token "+token)

	if c.SessionSecret == "" && c.EncryptionSecret == "" && c.CLIAuthSecret == "" {
		row("Secrets", "session, encryption, CLI: generated during the install")
	} else {
		gen := func(v string) string {
			if v == "" {
				return "(generated)"
			}
			return mask(v)
		}
		row("Secrets", "session "+gen(c.SessionSecret)+" · encryption "+gen(c.EncryptionSecret)+" · CLI "+gen(c.CLIAuthSecret))
	}
	row("Settings file", r.s.deps.ConfigPath+" (mode 600)")
	return out
}

// fixed is the body text below the scrolled rows.
func (r *reviewScreen) fixed() string {
	t := r.s.theme
	w := r.s.width - 2
	var b strings.Builder
	if len(r.problems) > 0 {
		b.WriteString(t.bad("These settings are incomplete; go back (esc) and fix them:") + "\n")
		for _, p := range r.problems {
			b.WriteString("  " + t.Fail.Render(p.Key) + ": " + p.Message + "\n")
		}
		return strings.TrimRight(b.String(), "\n")
	}
	b.WriteString(t.Muted.Render("Unattended equivalent, once this is saved:") + "\n")
	for _, l := range r.commandLines(w) {
		b.WriteString("  " + t.Code.Render(l) + "\n")
	}
	if r.writeErr != nil {
		b.WriteString("\n" + t.bad(wrap("Could not write "+r.s.deps.ConfigPath+": "+r.writeErr.Error(), w)) + "\n")
	}
	b.WriteString("\n" + r.form.View())
	return b.String()
}

// layout sizes the scrolled rows to what the fixed part leaves.
func (r *reviewScreen) layout() {
	fixed := strings.Count(r.fixed(), "\n") + 1
	avail := r.s.height - fixed - 1 // the blank (or scroll hint) line below the rows
	r.scroll.setLines(r.rows(), false)
	r.scroll.setHeight(max(avail, 3))
}

func (r *reviewScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if k, ok := msg.(tea.KeyPressMsg); ok {
		switch k.String() {
		case "up", "down", "pgup", "pgdown":
			r.scroll.key(k.String())
			return r, nil
		case "enter", "y", "n", "left", "right", "h", "l", "tab", "shift+tab":
			if len(r.problems) > 0 {
				return r, nil
			}
		}
	}
	if _, ok := msg.(tea.WindowSizeMsg); ok {
		defer r.layout()
	}
	completed, cmd := updateForm(r.form, msg)
	if !completed {
		return r, cmd
	}
	if !r.ok {
		return r, tea.Batch(cmd, goBack(r))
	}
	if err := r.s.cfg.Write(r.s.deps.ConfigPath); err != nil {
		again := r.Init() // a fresh confirm to try again
		r.writeErr = err
		r.layout()
		return r, tea.Batch(cmd, again)
	}
	return r, tea.Batch(cmd, done(r))
}

func (r *reviewScreen) View() tea.View {
	t := r.s.theme
	var b strings.Builder
	b.WriteString(r.scroll.view(r.s.width) + "\n")
	b.WriteString(t.Muted.Render(r.scroll.hint()) + "\n")
	b.WriteString(r.fixed())
	return tea.NewView(b.String())
}

// Apply has nothing left to do: the config was written on confirm.
func (r *reviewScreen) Apply(*config.Config) {}

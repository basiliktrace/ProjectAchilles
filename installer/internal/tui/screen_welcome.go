package tui

import (
	"errors"
	"fmt"
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
)

// welcomeScreen introduces the wizard or, over an existing install, offers
// Reconfigure / Upgrade / Status / Fresh install.
type welcomeScreen struct {
	s       *shared
	form    *huh.Form
	choice  string // reconfigure | upgrade | status | fresh
	confirm bool   // on the typed-hostname confirmation for a fresh install
	typed   string
	applied installMode
	dirty   bool // applied is meaningful
}

func newWelcome(s *shared) *welcomeScreen { return &welcomeScreen{s: s, choice: "reconfigure"} }

func (w *welcomeScreen) Title() string { return "Welcome" }

func (w *welcomeScreen) Help() string {
	if w.s.existing == nil {
		return "enter start · ctrl+c quit"
	}
	if w.confirm {
		return "enter confirm · esc back · ctrl+c quit"
	}
	return "↑/↓ choose · enter next · ctrl+c quit"
}

// installedName is what the admin must type to confirm a fresh install.
func (w *welcomeScreen) installedName() string {
	if n := strings.TrimSpace(w.s.existing.AchillesDomain); n != "" {
		return n
	}
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "fresh install"
}

func (w *welcomeScreen) Init() tea.Cmd {
	w.confirm = false
	if w.s.existing == nil {
		w.form = nil
		return nil
	}
	var cmd tea.Cmd
	w.form, cmd = w.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("What do you want to do?").
			Options(
				huh.NewOption("Reconfigure: change settings and re-apply (keeps data and the CA)", "reconfigure"),
				huh.NewOption("Upgrade: move to a newer ProjectAchilles release", "upgrade"),
				huh.NewOption("Status: show health, certificates and backups", "status"),
				huh.NewOption("Fresh install: start again from blank answers", "fresh"),
			).
			Value(&w.choice),
	))
	return cmd
}

func (w *welcomeScreen) Back() (bool, tea.Cmd) {
	if w.confirm {
		return true, w.Init()
	}
	return false, nil
}

func (w *welcomeScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if w.s.existing == nil {
		if k, ok := msg.(tea.KeyPressMsg); ok && k.String() == "enter" {
			return w, done(w)
		}
		return w, nil
	}
	completed, cmd := updateForm(w.form, msg)
	if !completed {
		return w, cmd
	}
	if w.confirm {
		w.s.mode = modeFresh
		return w, done(w)
	}
	switch w.choice {
	case "upgrade":
		return w, finish(ActionUpgrade)
	case "status":
		return w, finish(ActionStatus)
	case "fresh":
		w.confirm, w.typed = true, ""
		name := w.installedName()
		var c tea.Cmd
		w.form, c = w.s.newForm(huh.NewGroup(
			huh.NewInput().
				Title(fmt.Sprintf("Type %s to confirm", name)).
				Value(&w.typed).
				Validate(func(v string) error {
					if !strings.EqualFold(strings.TrimSpace(v), name) {
						return errors.New("that does not match the installed hostname")
					}
					return nil
				}),
		))
		return w, c
	default:
		w.s.mode = modeReconfigure
		return w, done(w)
	}
}

func (w *welcomeScreen) View() tea.View {
	t := w.s.theme
	var b strings.Builder
	if w.s.existing == nil {
		b.WriteString(wrap("This wizard sets up ProjectAchilles on this server (LAN or cloud).", w.s.width) + "\n\n")
		for i, step := range []string{
			"Check that this server is ready (read-only)",
			"Pick the network interface and the server's DNS name",
			"Choose how HTTPS certificates are issued",
			"Login (Clerk), analytics and organisation settings",
			"Review everything, then install",
		} {
			fmt.Fprintf(&b, "  %s %s\n", t.Brand.Render(fmt.Sprintf("%d.", i+1)), step)
		}
		b.WriteString("\n" + wrap("Nothing on this server changes until you confirm on the Review step. Press esc to go back at any time.", w.s.width) + "\n\n")
		b.WriteString(t.Strong.Render("Press enter to start."))
		return tea.NewView(b.String())
	}

	e := w.s.existing
	mode := e.TLSMode
	if mode == "" {
		mode = "acme-http"
	}
	name := e.AchillesDomain
	if name == "" {
		name = "(no domain set)"
	}
	b.WriteString(wrap("Existing install found: "+t.Strong.Render(name), w.s.width) + "\n")
	b.WriteString(t.Muted.Render(wrap("Certificates: "+mode+" · Settings: "+w.s.deps.ConfigPath, w.s.width)) + "\n\n")
	if w.confirm {
		b.WriteString(t.warn(wrap("A fresh install discards your previous answers and starts from blank. Data volumes, the CA and the generated secrets are kept.", w.s.width-2)) + "\n\n")
	}
	b.WriteString(w.form.View())
	return tea.NewView(b.String())
}

// Apply resets the answers when the install mode changes: Reconfigure starts
// from the existing config, Fresh from blank (keeping the generated secrets,
// which the existing data volumes are encrypted with).
func (w *welcomeScreen) Apply(c *config.Config) {
	if w.s.existing == nil || (w.dirty && w.applied == w.s.mode) {
		return
	}
	e := w.s.existing
	switch w.s.mode {
	case modeFresh:
		*c = config.Config{SessionSecret: e.SessionSecret, EncryptionSecret: e.EncryptionSecret, CLIAuthSecret: e.CLIAuthSecret}
	default:
		*c = *e
	}
	w.applied, w.dirty = w.s.mode, true
}

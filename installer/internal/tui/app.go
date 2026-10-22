// Package tui is the achilles-installer wizard: a Bubble Tea app that walks
// the admin through an ordered list of screens, each owning one part of
// deploy.config.env. The TUI only reads the host (preflight, DNS, the
// existing CA, the Clerk reachability probe); every change to the server is
// the engine's job, which the install screen runs. The TUI's own writes are
// the Enterprise-CA / bring-your-own certificate material under
// deploy/caddy/certs/ and, once the admin confirms on Review,
// deploy.config.env.
package tui

import (
	"fmt"
	"image/color"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
)

// DefaultCADir is where the engine keeps the ProjectAchilles CA.
const DefaultCADir = "/etc/projectachilles/ca"

// Deps is everything the wizard reads from the outside world.
type Deps struct {
	System     sysprobe.System
	Resolver   dnsclass.Resolver
	Interfaces func() []sysprobe.Iface
	RepoRoot   string                             // the ProjectAchilles checkout, e.g. /opt/projectachilles
	ConfigPath string                             // its deploy.config.env
	Runner     func(config.Config) engine.Starter // a fresh engine run for the confirmed answers
	Now        func() time.Time
	CADir      string // an existing ProjectAchilles CA is read from here (default DefaultCADir)
}

// Screen is one wizard step. It is a tea.Model; Init runs every time the
// screen becomes current (forwards or back), so it (re)builds itself from
// the shared answers. Apply writes the screen's answers into the config when
// the screen completes.
//
// A screen signals completion by returning the command from done(s). It may
// also implement:
//
//	Back() (handled bool, cmd tea.Cmd) // esc inside a multi-step screen
//	Help() string                      // replaces the default key hints
//	Quit() (handled bool, cmd tea.Cmd) // ctrl+c (e.g. confirm before stopping the engine)
type Screen interface {
	tea.Model
	Title() string
	Apply(*config.Config)
}

type backHandler interface{ Back() (bool, tea.Cmd) }
type helpProvider interface{ Help() string }
type quitGuard interface{ Quit() (bool, tea.Cmd) }

// Action is what the wizard ended with.
type Action int

const (
	ActionAbort         Action = iota // ctrl+c
	ActionInstall                     // every screen completed
	ActionUpgrade                     // existing install: run `upgrade`
	ActionStatus                      // existing install: run `status`
	ActionInstallFailed               // the install ran (deploy.config.env written) but did not finish
)

func (a Action) String() string {
	return [...]string{"abort", "install", "upgrade", "status", "install-failed"}[a]
}

// Outcome is the wizard's result.
type Outcome struct {
	Action Action
	Config config.Config
	// Summary is the done screen's text, unstyled, for printing to the
	// terminal once the alternate screen is gone (ActionInstall only).
	Summary string
}

// nextMsg completes screen from; it is ignored if from is no longer current
// (the admin went back before an async step finished).
type nextMsg struct{ from Screen }

// finishMsg ends the wizard early with action.
type finishMsg struct{ action Action }

func done(from Screen) tea.Cmd { return func() tea.Msg { return nextMsg{from: from} } }

func finish(a Action) tea.Cmd { return func() tea.Msg { return finishMsg{action: a} } }

// backMsg goes back one screen, as esc does.
type backMsg struct{ from Screen }

func goBack(from Screen) tea.Cmd { return func() tea.Msg { return backMsg{from: from} } }

// installMode is how this run relates to an existing install.
type installMode int

const (
	modeNew installMode = iota
	modeReconfigure
	modeFresh
)

// shared is the state every screen reads: dependencies, answers so far and
// layout.
type shared struct {
	deps     Deps
	existing *config.Config
	cfg      *config.Config
	mode     installMode
	theme    theme
	keymap   *huh.KeyMap
	width    int // usable body width
	height   int // usable body height

	// Results of earlier screens that later screens build on.
	checks []sysprobe.Check
	iface  sysprobe.Iface
	class  dnsclass.Result

	summary   string // the done screen's plain text (Outcome.Summary)
	engineRan bool   // the install screen has started the engine at least once
}

func (s *shared) now() time.Time {
	if s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}

// newForm builds a Huh form with the wizard's theme, keys and width, and
// initialises it immediately so its first field is focused before the next
// keystroke arrives.
func (s *shared) newForm(groups ...*huh.Group) (*huh.Form, tea.Cmd) {
	f := huh.NewForm(groups...).
		WithTheme(s.theme.huhTheme()).
		WithKeyMap(s.keymap).
		WithShowHelp(false).
		WithWidth(s.width)
	f.SubmitCmd, f.CancelCmd = nil, nil
	cmd := f.Init()
	// Size the groups now: until a form sees a WindowSizeMsg its viewport
	// clips the last lines, and a form built mid-run may never get one.
	_, sized := f.Update(tea.WindowSizeMsg{Width: s.width, Height: s.height})
	// Forms default to a light background; tell new ones what we know.
	bg := color.Color(color.White)
	if s.theme.dark {
		bg = color.Black
	}
	_, colored := f.Update(tea.BackgroundColorMsg{Color: bg})
	// Keep those updates' commands: they carry the first evaluation of any
	// TitleFunc/DescriptionFunc (dropping them leaves it blank until its
	// binding changes).
	return f, tea.Batch(cmd, sized, colored)
}

// updateForm forwards msg to f and reports whether it just completed.
func updateForm(f *huh.Form, msg tea.Msg) (bool, tea.Cmd) {
	if f == nil {
		return false, nil
	}
	_, cmd := f.Update(msg) // a Form updates in place and returns itself
	return f.State == huh.StateCompleted, cmd
}

func keymap() *huh.KeyMap {
	km := huh.NewDefaultKeyMap()
	km.Quit = key.NewBinding(key.WithDisabled()) // the app owns ctrl+c
	km.Select.Filter = key.NewBinding(key.WithDisabled())
	km.Select.SetFilter = key.NewBinding(key.WithDisabled())
	km.Select.ClearFilter = key.NewBinding(key.WithDisabled())
	return km
}

// App is the wizard's root model.
type App struct {
	s       *shared
	cfg     config.Config
	screens []Screen
	idx     int
	width   int
	height  int
	outcome Outcome
}

// Layout: header (2 lines) + body + footer (2 lines).
const chromeLines = 4

// New builds the wizard. existing is the current deploy.config.env of an
// installed system, or nil for a first install.
func New(d Deps, existing *config.Config) tea.Model { return newApp(d, existing) }

func newApp(d Deps, existing *config.Config) *App {
	if d.CADir == "" {
		d.CADir = DefaultCADir
	}
	a := &App{width: 80, height: 24}
	if existing != nil {
		a.cfg = *existing
	}
	a.s = &shared{deps: d, existing: existing, cfg: &a.cfg, theme: newTheme(true), keymap: keymap()}
	a.layout(80, 24)
	a.screens = buildScreens(a.s)
	return a
}

// buildScreens is the ordered wizard.
func buildScreens(s *shared) []Screen {
	return []Screen{
		newWelcome(s),
		newPreflight(s),
		newNetwork(s),
		newCerts(s),
		newLogin(s),
		newAnalytics(s),
		newOrg(s),
		newReview(s),
		newInstall(s),
		newDone(s),
	}
}

// Close stops an engine run that is still going (the program ended while
// installing) and waits for it to exit. Safe to call more than once.
func (a *App) Close() {
	for _, sc := range a.screens {
		if in, ok := sc.(*installScreen); ok {
			in.stop()
		}
	}
}

// Outcome returns how the wizard ended and the answers collected.
func (a *App) Outcome() Outcome { return a.outcome }

func (a *App) cur() Screen { return a.screens[a.idx] }

func (a *App) layout(w, h int) {
	a.width, a.height = w, h
	a.s.width = max(w-2, 20)
	a.s.height = max(h-chromeLines, 4)
}

func (a *App) Init() tea.Cmd {
	return tea.Batch(tea.RequestBackgroundColor, a.cur().Init())
}

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.layout(msg.Width, msg.Height)
		// Screens (and their forms) size themselves to the body, not the
		// whole terminal.
		msg = tea.WindowSizeMsg{Width: a.s.width, Height: a.s.height}
		m, cmd := a.cur().Update(msg)
		a.screens[a.idx] = m.(Screen)
		return a, cmd
	case tea.BackgroundColorMsg:
		a.s.theme = newTheme(msg.IsDark())
	case tea.KeyPressMsg:
		switch msg.String() {
		case "ctrl+c":
			if q, ok := a.cur().(quitGuard); ok {
				if handled, cmd := q.Quit(); handled {
					return a, cmd
				}
			}
			// Once the engine has run, the server has changed: quitting is a
			// failed install, not a no-op cancel.
			action := ActionAbort
			if a.s.engineRan {
				action = ActionInstallFailed
			}
			a.outcome = Outcome{Action: action, Config: a.cfg}
			return a, tea.Quit
		case "esc":
			return a, a.back()
		}
	case nextMsg:
		if msg.from != a.cur() {
			return a, nil
		}
		return a, a.advance()
	case backMsg:
		if msg.from != a.cur() {
			return a, nil
		}
		return a, a.back()
	case finishMsg:
		a.outcome = Outcome{Action: msg.action, Config: a.cfg, Summary: a.s.summary}
		return a, tea.Quit
	}
	m, cmd := a.cur().Update(msg)
	a.screens[a.idx] = m.(Screen)
	return a, cmd
}

func (a *App) back() tea.Cmd {
	if b, ok := a.cur().(backHandler); ok {
		if handled, cmd := b.Back(); handled {
			return cmd
		}
	}
	if a.idx == 0 {
		return nil
	}
	a.idx--
	return a.cur().Init()
}

func (a *App) advance() tea.Cmd {
	a.cur().Apply(&a.cfg)
	if a.idx == len(a.screens)-1 {
		a.outcome = Outcome{Action: ActionInstall, Config: a.cfg, Summary: a.s.summary}
		return tea.Quit
	}
	a.idx++
	return a.cur().Init()
}

func (a *App) View() tea.View {
	v := tea.NewView(a.render())
	v.AltScreen = true
	v.WindowTitle = "ProjectAchilles installer · " + a.cur().Title()
	return v
}

const defaultHelp = "enter next · esc back · ctrl+c quit"

func (a *App) render() string {
	t := a.s.theme
	w := a.width

	left := t.Brand.Render("ProjectAchilles") + t.Muted.Render(" installer")
	right := t.Title.Render(a.cur().Title()) + "  " + t.Muted.Render(fmt.Sprintf("%d / %d", a.idx+1, len(a.screens)))
	gap := max(w-2-lipgloss.Width(left)-lipgloss.Width(right), 1)
	header := " " + left + strings.Repeat(" ", gap) + right
	rule := t.Rule.Render(strings.Repeat("─", w))

	body := strings.Split(strings.TrimRight(a.cur().View().Content, "\n"), "\n")
	bodyH := max(a.height-chromeLines, 1)
	if len(body) > bodyH {
		body = body[:bodyH]
	}
	for i, l := range body {
		body[i] = ansi.Truncate(" "+l, w-1, "…")
	}
	for len(body) < bodyH {
		body = append(body, "")
	}

	help := defaultHelp
	if h, ok := a.cur().(helpProvider); ok {
		help = h.Help()
	}
	footer := " " + t.Muted.Render(ansi.Truncate(help, w-2, "…"))

	lines := append([]string{ansi.Truncate(header, w, ""), rule}, body...)
	lines = append(lines, rule, footer)
	return strings.Join(lines, "\n")
}

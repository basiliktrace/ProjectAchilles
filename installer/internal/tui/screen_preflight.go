package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
)

// preflightTimeout bounds the whole check run (the egress checks dominate).
const preflightTimeout = 45 * time.Second

// preflightScreen runs the read-only host checks once and blocks Next while
// any of them fails.
type preflightScreen struct {
	s       *shared
	gen     int
	running bool
	checks  []sysprobe.Check
	blocked string
	spin    spinner.Model
}

type preflightDoneMsg struct {
	gen    int
	checks []sysprobe.Check
}

func newPreflight(s *shared) *preflightScreen {
	return &preflightScreen{s: s, spin: spinner.New(spinner.WithSpinner(spinner.Line))}
}

func (p *preflightScreen) Title() string { return "Preflight checks" }

func (p *preflightScreen) Help() string {
	return "enter next · r re-run checks · esc back · ctrl+c quit"
}

// Init runs the checks the first time; coming back keeps the results
// (press r to run them again).
func (p *preflightScreen) Init() tea.Cmd {
	p.blocked = ""
	if p.checks != nil || p.running {
		return nil
	}
	return p.run()
}

func (p *preflightScreen) run() tea.Cmd {
	p.gen++
	p.running, p.checks, p.blocked = true, nil, ""
	gen, sys := p.gen, p.s.deps.System
	opts := sysprobe.PreflightOptions{ExistingInstall: p.s.existing != nil}
	return tea.Batch(p.spin.Tick, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), preflightTimeout)
		defer cancel()
		return preflightDoneMsg{gen: gen, checks: sysprobe.Preflight(ctx, sys, opts)}
	})
}

func (p *preflightScreen) failed() []sysprobe.Check {
	var out []sysprobe.Check
	for _, c := range p.checks {
		if c.Status == sysprobe.Fail {
			out = append(out, c)
		}
	}
	return out
}

func (p *preflightScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case preflightDoneMsg:
		if msg.gen == p.gen {
			p.running, p.checks = false, msg.checks
			p.s.checks = msg.checks
		}
	case spinner.TickMsg:
		if p.running {
			var cmd tea.Cmd
			p.spin, cmd = p.spin.Update(msg)
			return p, cmd
		}
	case tea.KeyPressMsg:
		switch msg.String() {
		case "r":
			if !p.running {
				return p, p.run()
			}
		case "enter":
			if p.running {
				return p, nil
			}
			if f := p.failed(); len(f) > 0 {
				names := make([]string, len(f))
				for i, c := range f {
					names[i] = c.Title
				}
				p.blocked = fmt.Sprintf("Next is blocked: %s failed (%s). Fix it, then press r to re-run the checks.",
					plural(len(f), "check"), strings.Join(names, ", "))
				return p, nil
			}
			return p, done(p)
		}
	}
	return p, nil
}

const (
	checkTitleWidth = 28
	checkGlyphWidth = 6
)

func (p *preflightScreen) View() tea.View {
	t := p.s.theme
	w := p.s.width
	var b strings.Builder
	b.WriteString(t.Muted.Render("Read-only checks: nothing on this server is changed.") + "\n\n")
	if p.running {
		b.WriteString(p.spin.View() + " Running checks…")
		return tea.NewView(b.String())
	}
	var pass, warn, fail int
	detailCol := 1 + checkGlyphWidth + 2 + checkTitleWidth
	for _, c := range p.checks {
		switch c.Status {
		case sysprobe.Pass:
			pass++
		case sysprobe.Warn:
			warn++
		default:
			fail++
		}
		title := c.Title + strings.Repeat(" ", max(checkTitleWidth-lipgloss.Width(c.Title), 1))
		line := " " + t.status(c.Status) + "  " + title
		switch {
		case c.Detail == "":
		case detailCol+lipgloss.Width(c.Detail) <= w || c.Status == sysprobe.Pass:
			line += t.Muted.Render(ansi.Truncate(c.Detail, max(w-detailCol, 8), "…"))
		default:
			// A warning or failure keeps its whole explanation, wrapped
			// under the title.
			line = strings.TrimRight(line, " ") + "\n" +
				indent(wrap(c.Detail, w-(1+checkGlyphWidth+2)), strings.Repeat(" ", 1+checkGlyphWidth+2))
		}
		b.WriteString(strings.TrimRight(line, " ") + "\n")
	}
	b.WriteString("\n")
	summary := fmt.Sprintf("%d passed · %s · %d failed", pass, plural(warn, "warning"), fail)
	switch {
	case fail > 0:
		b.WriteString(t.Fail.Render(summary))
	case warn > 0:
		b.WriteString(t.Warn.Render(summary))
	default:
		b.WriteString(t.Pass.Render(summary))
	}
	if p.blocked != "" {
		b.WriteString("\n\n" + t.bad(wrap(p.blocked, w-2)))
	}
	return tea.NewView(b.String())
}

// Apply has nothing to write: preflight only gates the wizard. Its results
// stay in shared.checks (e.g. sysprobe.ESSelfAllowed for the analytics step).
func (p *preflightScreen) Apply(*config.Config) {}

// plural formats n with noun, adding an "s" unless n == 1.
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

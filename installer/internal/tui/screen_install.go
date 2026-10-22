package tui

import (
	"context"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
)

// failTail is how many log lines the failure view offers.
const failTail = 30

// installScreen runs the engine for the confirmed answers and shows its
// phase checklist and output. Retry re-runs the whole engine (it is
// idempotent) with a fresh Runner; the log keeps the last logLimit lines
// across runs.
type installScreen struct {
	s       *shared
	state   installState
	confirm bool // asking whether to stop the running engine

	gen      int // current run; messages from older runs are dropped
	runs     int
	events   <-chan engine.Event
	cancel   context.CancelFunc
	wait     func() error
	stopping bool // the admin stopped this run

	order    []string
	titles   map[string]string
	status   map[string]phaseState
	current  string
	failID   string
	failMsg  string
	exitCode int
	warnings []string

	log    logBuffer
	scroll scroller
}

func newInstall(s *shared) *installScreen { return &installScreen{s: s} }

func (in *installScreen) Title() string { return "Install" }

func (in *installScreen) Help() string {
	switch {
	case in.confirm:
		return "y stop the install · n keep going"
	case in.state == instRunning:
		return "↑/↓ scroll log · esc stop · ctrl+c stop and quit"
	case in.state == instSucceeded:
		return "enter next steps · ctrl+c quit"
	}
	return "r retry · q quit · ↑/↓ scroll log · esc back to review"
}

// Init starts a run whenever the screen is entered from Review.
func (in *installScreen) Init() tea.Cmd {
	in.confirm = false
	if in.state == instRunning && in.wait != nil {
		return nil
	}
	return in.start()
}

func (in *installScreen) Back() (bool, tea.Cmd) {
	switch in.state {
	case instRunning:
		in.confirm = !in.confirm
		in.layout()
		return true, nil
	case instSucceeded:
		return true, nil // nothing to go back to once installed
	}
	return false, nil // failed or stopped: back to Review
}

// Quit asks before stopping a running engine; a second ctrl+c stops it.
func (in *installScreen) Quit() (bool, tea.Cmd) {
	switch in.state {
	case instRunning:
		if !in.confirm {
			in.confirm = true
			in.layout()
			return true, nil
		}
		in.stopping = true
		in.cancel()
		return true, finish(ActionInstallFailed)
	case instSucceeded:
		return true, finish(ActionInstall)
	}
	return true, finish(ActionInstallFailed)
}

func (in *installScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case engineEventsMsg:
		if msg.gen != in.gen {
			return in, nil
		}
		for _, ev := range msg.events {
			in.apply(ev)
		}
		in.layout()
		if msg.closed {
			gen, wait := in.gen, in.wait
			return in, func() tea.Msg { return engineExitMsg{gen: gen, err: wait()} }
		}
		return in, in.read()
	case engineExitMsg:
		if msg.gen == in.gen && in.state == instRunning {
			in.exited(msg.err)
		}
		return in, nil
	case tea.WindowSizeMsg:
		in.layout()
	case tea.KeyPressMsg:
		k := msg.String()
		if in.confirm {
			switch k {
			case "y", "Y":
				in.confirm, in.stopping = false, true
				in.cancel()
			case "n", "N", "enter":
				in.confirm = false
			}
			in.layout()
			return in, nil
		}
		switch in.state {
		case instSucceeded:
			if k == "enter" {
				return in, done(in)
			}
		case instFailed, instStopped:
			switch k {
			case "r", "R":
				return in, in.start()
			case "q", "Q":
				return in, finish(ActionInstallFailed)
			}
		}
		in.scroll.key(k)
	}
	return in, nil
}

// layout sizes the log view for the current state.
func (in *installScreen) layout() {
	h := in.s.height
	switch in.state {
	case instRunning:
		in.scroll.setLines(in.log.all(), true)
		rest := h - 2 - len(in.order) - 1 // header + blank, checklist, blank
		if in.confirm {
			rest -= 4 // blank, the question (two lines), the keys
		}
		in.scroll.setHeight(max(rest, 1))
	case instFailed, instStopped:
		if len(in.scroll.lines) == 0 {
			in.scroll.setLines(in.log.tail(failTail), true)
			in.scroll.bottom()
		}
		in.scroll.setHeight(max(h-len(in.failHead())-4, 3))
	}
}

const glyphW = 11

func (in *installScreen) glyph(st phaseState) string {
	t := in.s.theme
	var g string
	switch st {
	case phaseRunning:
		g = lipgloss.NewStyle().Bold(true).Foreground(t.accent).Render("» running")
	case phaseOK:
		g = t.Pass.Render("✓ done")
	case phaseFailed:
		g = t.Fail.Render("✗ failed")
	case phaseSkipped:
		g = t.Muted.Render("– skipped")
	case phaseStopped:
		g = t.Warn.Render("■ stopped")
	default:
		g = t.Muted.Render("· pending")
	}
	return g + strings.Repeat(" ", max(glyphW-lipgloss.Width(g), 1))
}

func (in *installScreen) checklist() string {
	var b strings.Builder
	for _, id := range in.order {
		st := in.status[id]
		title := in.title(id)
		if st == phaseFailed || st == phaseStopped {
			title = in.s.theme.Strong.Render(title)
		}
		b.WriteString(" " + in.glyph(st) + title + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// failHead is the failed/stopped summary, the failing phase highlighted.
func (in *installScreen) failHead() []string {
	t := in.s.theme
	w := in.s.width - 2
	ok, failed, notRun, _ := in.counts()
	id := in.failID
	if in.state == instStopped {
		id = in.current
	}
	where := in.title(id)
	if id == "" {
		where = "before the first phase"
	}
	var lines []string
	add := func(s string) { lines = append(lines, strings.Split(s, "\n")...) }
	if in.state == instStopped {
		add(t.Warn.Render("■") + " " + hang(wrap("Install stopped during: "+t.Strong.Render(where), w)))
		add("  " + hang(wrap("Nothing after it ran. Running the install again is safe: every phase is idempotent.", w)))
		add(t.Muted.Render(fmt.Sprintf("  %d phases done · 1 stopped · %d not run", ok, notRun)))
		return lines
	}
	add(t.Fail.Render("✗") + " " + hang(wrap("Install failed at: "+t.Strong.Render(where), w)))
	if in.failMsg != "" {
		add("  " + hang(wrap(in.failMsg, w)))
	}
	add(t.Muted.Render(fmt.Sprintf("  %d phases done · %d failed · %d not run · exit status %d", ok, failed, notRun, in.exitCode)))
	return lines
}

func (in *installScreen) View() tea.View {
	t := in.s.theme
	w := in.s.width
	var b strings.Builder
	switch in.state {
	case instRunning:
		b.WriteString(t.Strong.Render("Installing ProjectAchilles on this server.") + t.Muted.Render(" This can take several minutes.") + "\n\n")
		b.WriteString(in.checklist() + "\n\n")
		b.WriteString(in.scroll.view(w))
		if in.confirm {
			b.WriteString("\n\n" + t.warn(wrap("Stop the install? The engine stops where it is; running it again later is safe.", w-2)) + "\n")
			b.WriteString("  " + t.KeyHint.Render("y") + " stop · " + t.KeyHint.Render("n") + " or " + t.KeyHint.Render("enter") + " keep going")
		}
	case instSucceeded:
		ok, _, _, skipped := in.counts()
		head := fmt.Sprintf("✓ Install complete · %d phases done · %d skipped (not used in this mode)", ok, skipped)
		b.WriteString(t.Pass.Render(head) + "\n\n")
		b.WriteString(in.checklist() + "\n")
		room := in.s.height - 2 - len(in.order) - 3
		if n := len(in.warnings); n > 0 && room > 1 {
			b.WriteString("\n" + t.Warn.Render(fmt.Sprintf("%s:", plural(n, "warning"))) + "\n")
			for _, wmsg := range in.warnings[max(n-(room-1), 0):] {
				b.WriteString("  " + wmsg + "\n")
			}
		}
		b.WriteString("\n" + t.Strong.Render("Press enter for the next steps."))
	default:
		b.WriteString(strings.Join(in.failHead(), "\n") + "\n\n")
		b.WriteString(t.Muted.Render(fmt.Sprintf("Last %d log lines", failTail)))
		if h := in.scroll.hint(); h != "" {
			b.WriteString(t.Muted.Render(" · " + h))
		}
		b.WriteString(":\n" + in.scroll.view(w) + "\n\n")
		b.WriteString(t.KeyHint.Render("r") + " retry (re-runs the whole install; it is idempotent) · " + t.KeyHint.Render("q") + " quit")
	}
	return tea.NewView(b.String())
}

// Apply has nothing to record: the engine ran from the written config.
func (in *installScreen) Apply(*config.Config) {}

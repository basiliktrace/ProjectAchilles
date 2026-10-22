package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// scroller is a minimal vertical viewport over pre-rendered lines. Lines
// wider than the view are truncated, never wrapped, so a command keeps its
// shape. It follows the bottom while the view is at the bottom.
type scroller struct {
	lines  []string
	off    int
	height int
}

func (sc *scroller) maxOff() int { return max(len(sc.lines)-sc.height, 0) }

func (sc *scroller) atBottom() bool { return sc.off >= sc.maxOff() }

// setLines replaces the content. follow keeps the view pinned to the bottom
// if it was there (a log); otherwise the offset is only clamped.
func (sc *scroller) setLines(lines []string, follow bool) {
	pinned := sc.atBottom()
	sc.lines = lines
	if follow && pinned {
		sc.off = sc.maxOff()
	}
	sc.off = min(max(sc.off, 0), sc.maxOff())
}

func (sc *scroller) setHeight(h int) {
	pinned := sc.atBottom()
	sc.height = max(h, 1)
	if pinned {
		sc.off = sc.maxOff()
	}
	sc.off = min(sc.off, sc.maxOff())
}

func (sc *scroller) bottom() { sc.off = sc.maxOff() }
func (sc *scroller) top()    { sc.off = 0 }

// key scrolls for up/down/pgup/pgdown/home/end and reports whether it did.
func (sc *scroller) key(k string) bool {
	switch k {
	case "up", "k":
		sc.off--
	case "down", "j":
		sc.off++
	case "pgup", "b":
		sc.off -= max(sc.height-1, 1)
	case "pgdown", "f", " ", "space":
		sc.off += max(sc.height-1, 1)
	case "home", "g":
		sc.off = 0
	case "end", "G":
		sc.off = sc.maxOff()
	default:
		return false
	}
	sc.off = min(max(sc.off, 0), sc.maxOff())
	return true
}

// scrollable reports whether there is more content than fits.
func (sc *scroller) scrollable() bool { return len(sc.lines) > sc.height }

// view renders the visible lines, each truncated to width.
func (sc *scroller) view(width int) string {
	end := min(sc.off+sc.height, len(sc.lines))
	out := make([]string, 0, sc.height)
	for _, l := range sc.lines[sc.off:end] {
		out = append(out, ansi.Truncate(l, width, "…"))
	}
	return strings.Join(out, "\n")
}

// hint is a one-line scroll position note, or "" when everything fits.
func (sc *scroller) hint() string {
	switch {
	case !sc.scrollable():
		return ""
	case sc.off == 0:
		return "↓ more below · ↑/↓ scroll"
	case sc.atBottom():
		return "↑ more above · ↑/↓ scroll"
	default:
		return "↑/↓ more above and below"
	}
}

// logLimit is how many engine output lines the install screen keeps.
const logLimit = 2000

// logBuffer keeps the last logLimit lines.
type logBuffer struct{ lines []string }

func (b *logBuffer) add(line string) {
	b.lines = append(b.lines, line)
	// Trim in batches so a long log is not copied on every line.
	if len(b.lines) > logLimit+logLimit/4 {
		b.lines = append([]string(nil), b.lines[len(b.lines)-logLimit:]...)
	}
}

// all returns the kept lines, oldest first.
func (b *logBuffer) all() []string {
	if len(b.lines) > logLimit {
		return b.lines[len(b.lines)-logLimit:]
	}
	return b.lines
}

// tail returns the last n kept lines.
func (b *logBuffer) tail(n int) []string {
	all := b.all()
	return all[max(len(all)-n, 0):]
}

// maskMark prefixes a masked secret.
const maskMark = "••••"

// mask shows a secret as •••• plus its last four characters, or only ••••
// when it is too short for the tail to be safe to show.
func mask(v string) string {
	r := []rune(strings.TrimSpace(v))
	if len(r) < 12 {
		return maskMark
	}
	return maskMark + string(r[len(r)-4:])
}

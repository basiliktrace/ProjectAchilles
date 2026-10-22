// Package engine runs scripts/deploy-server.sh and turns its machine-readable
// progress lines into events for the TUI.
package engine

import (
	"regexp"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// EventKind classifies one line of installer output.
type EventKind int

const (
	Phase EventKind = iota
	OK
	Warn
	Fail
	Log
)

// Event is one parsed output line. ID is set for Phase, OK and Fail; Text is
// the phase title, warning/failure message, or the raw line for Log.
type Event struct {
	Kind EventKind
	ID   string
	Text string
}

var progressIDRe = regexp.MustCompile(`^[a-z0-9-]+$`)

// ParseLine parses one output line. Anything that is not a well-formed
// `::phase|ok|warn|fail` line at the start of the line becomes a Log event.
func ParseLine(line string) Event {
	line = strings.TrimRight(line, "\r\n")
	log := Event{Kind: Log, Text: line}
	if !strings.HasPrefix(line, "::") {
		return log
	}
	verb, rest, _ := strings.Cut(line[2:], " ")
	rest = strings.TrimSpace(rest)
	switch verb {
	case "warn":
		return Event{Kind: Warn, Text: rest}
	case "phase", "ok", "fail":
		id, text, _ := strings.Cut(rest, " ")
		if !progressIDRe.MatchString(id) {
			return log
		}
		text = strings.TrimSpace(text)
		switch verb {
		case "phase":
			return Event{Kind: Phase, ID: id, Text: text}
		case "ok":
			return Event{Kind: OK, ID: id}
		default:
			return Event{Kind: Fail, ID: id, Text: text}
		}
	}
	return log
}

// Sanitize makes one line of engine output safe to show on a terminal or in
// a log: escape sequences (colours, cursor movement, OSC) are removed, tabs
// are expanded, a carriage-return redraw keeps only its final state, and
// any other control character is dropped.
func Sanitize(s string) string {
	s = ansi.Strip(s)
	if i := strings.LastIndexByte(strings.TrimRight(s, "\r"), '\r'); i >= 0 {
		s = s[i+1:]
	}
	s = strings.ReplaceAll(s, "\t", "    ")
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

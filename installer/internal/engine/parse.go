// Package engine runs scripts/deploy-server.sh and turns its machine-readable
// progress lines into events for the TUI.
package engine

import (
	"regexp"
	"strings"
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

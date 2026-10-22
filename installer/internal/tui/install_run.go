package tui

// The install screen's engine run: starting and stopping it, and turning
// its events into the phase checklist and the log.

import (
	"context"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
)

type phaseState int

const (
	phasePending phaseState = iota
	phaseRunning
	phaseOK
	phaseFailed
	phaseSkipped // never emitted by a run that succeeded (mode-dependent)
	phaseStopped // running when the admin stopped the install
)

type installState int

const (
	instRunning installState = iota
	instSucceeded
	instFailed
	instStopped
)

// eventBatch caps how many queued engine events one message carries.
const eventBatch = 256

// phaseLabels name the phases before the engine announces them.
var phaseLabels = map[string]string{
	"config": "Loading configuration", "validate": "Validating settings", "docker": "Checking Docker",
	"ca": "Preparing the ProjectAchilles CA", "caddy-render": "Configuring Caddy TLS",
	"backend-env": "Writing backend/.env", "root-env": "Writing root .env",
	"firewall": "Opening 80/443 to the LAN subnets", "up": "Building and starting the stack",
	"ca-export": "Exporting Caddy's internal root CA", "bootstrap": "Rendering endpoint bootstrap scripts",
	"renew-timer": "Installing the weekly CA renewal timer",
}

type engineEventsMsg struct {
	gen    int
	events []engine.Event
	closed bool
}

type engineExitMsg struct {
	gen int
	err error
}

func (in *installScreen) start() tea.Cmd {
	in.stop()
	in.gen++
	in.runs++
	if in.runs > 1 {
		in.log.add(fmt.Sprintf("──────── retry %d ────────", in.runs-1))
	}
	in.order = append([]string(nil), engine.PhaseOrder...)
	in.titles, in.status = map[string]string{}, map[string]phaseState{}
	for _, id := range in.order {
		in.status[id] = phasePending
	}
	in.current, in.failID, in.failMsg, in.exitCode, in.warnings, in.stopping = "", "", "", 0, nil, false
	in.state, in.confirm = instRunning, false
	in.scroll = scroller{}

	if in.s.deps.Runner == nil {
		in.failRun("no installer engine is configured")
		return nil
	}
	in.s.engineRan = true
	ctx, cancel := context.WithCancel(context.Background())
	ch, wait, err := in.s.deps.Runner(*in.s.cfg).Start(ctx)
	if err != nil {
		cancel()
		in.failRun("could not start the installer engine: " + err.Error())
		return nil
	}
	in.events, in.cancel, in.wait = ch, cancel, wait
	in.layout()
	return in.read()
}

// failRun ends a run that never started.
func (in *installScreen) failRun(msg string) {
	in.state, in.failMsg, in.exitCode = instFailed, msg, 1
	in.log.add("✗ " + msg)
	in.layout()
}

// stop cancels a run that is still going and waits for it to exit. It is
// safe to call at any time and more than once.
func (in *installScreen) stop() {
	if in.cancel != nil {
		in.cancel()
	}
	if in.wait != nil {
		_ = in.wait()
	}
	in.cancel, in.wait = nil, nil
}

// read waits for the next engine events (up to eventBatch at once).
func (in *installScreen) read() tea.Cmd {
	gen, ch := in.gen, in.events
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return engineEventsMsg{gen: gen, closed: true}
		}
		batch := []engine.Event{ev}
		for len(batch) < eventBatch {
			select {
			case ev, ok := <-ch:
				if !ok {
					return engineEventsMsg{gen: gen, events: batch, closed: true}
				}
				batch = append(batch, ev)
			default:
				return engineEventsMsg{gen: gen, events: batch}
			}
		}
		return engineEventsMsg{gen: gen, events: batch}
	}
}

func (in *installScreen) title(id string) string {
	if t := in.titles[id]; t != "" {
		return t
	}
	if t := phaseLabels[id]; t != "" {
		return t
	}
	return id
}

func (in *installScreen) known(id string) {
	if _, ok := in.status[id]; !ok {
		in.order = append(in.order, id)
		in.status[id] = phasePending
	}
}

func (in *installScreen) apply(ev engine.Event) {
	switch ev.Kind {
	case engine.Phase:
		if in.current != "" && in.status[in.current] == phaseRunning {
			in.status[in.current] = phaseOK
		}
		in.known(ev.ID)
		in.current, in.status[ev.ID] = ev.ID, phaseRunning
		if t := cleanLogLine(ev.Text); t != "" {
			in.titles[ev.ID] = t
		}
		in.log.add("==> " + in.title(ev.ID))
	case engine.OK:
		in.known(ev.ID)
		in.status[ev.ID] = phaseOK
	case engine.Warn:
		msg := cleanLogLine(ev.Text)
		in.warnings = append(in.warnings, msg)
		in.log.add("! " + msg)
	case engine.Fail:
		in.known(ev.ID)
		in.failID, in.failMsg = ev.ID, cleanLogLine(ev.Text)
		in.status[ev.ID] = phaseFailed
		in.log.add("✗ " + in.failMsg)
	default:
		in.log.add(cleanLogLine(ev.Text))
	}
}

// exited settles the checklist once the engine is gone.
func (in *installScreen) exited(err error) {
	if in.cancel != nil {
		in.cancel() // release the context
	}
	in.cancel, in.wait = nil, nil
	in.exitCode = engine.ExitCode(err)
	switch {
	case in.stopping:
		in.state = instStopped
		for id, st := range in.status {
			if st == phaseRunning {
				in.status[id] = phaseStopped
			}
		}
		in.log.add("■ stopped by the admin")
	case err == nil && in.failID == "":
		in.state = instSucceeded
		for id, st := range in.status {
			switch st {
			case phaseRunning:
				in.status[id] = phaseOK
			case phasePending:
				in.status[id] = phaseSkipped
			}
		}
	default:
		in.state = instFailed
		if in.failID == "" {
			in.failID = in.current
			in.failMsg = fmt.Sprintf("the engine exited with status %d", in.exitCode)
			if err != nil && in.exitCode == 1 && !strings.Contains(err.Error(), "exit status") {
				in.failMsg = "the engine stopped: " + err.Error()
			}
			in.log.add("✗ " + in.failMsg)
		}
		if in.failID != "" {
			in.status[in.failID] = phaseFailed
		}
	}
	in.scroll = scroller{}
	in.layout()
}

// counts summarises the checklist (failed includes a stopped phase).
func (in *installScreen) counts() (ok, failed, notRun, skipped int) {
	for _, id := range in.order {
		switch in.status[id] {
		case phaseOK:
			ok++
		case phaseFailed, phaseStopped:
			failed++
		case phaseSkipped:
			skipped++
		default:
			notRun++
		}
	}
	return
}

package engine

import (
	"context"
	"errors"
)

// Starter starts one engine run. Runner is the real implementation; the TUI
// and the unattended install take a Starter so tests can fake the engine.
// Start has Runner.Start's contract: drain the channel (or cancel ctx), and
// the wait func is safe to call at any time.
type Starter interface {
	Start(ctx context.Context) (<-chan Event, func() error, error)
}

var _ Starter = Runner{}

// ExitCode is the process exit status carried by err, as returned by a
// Starter's wait func: 0 for nil, the status for an *exec.ExitError (or any
// error with an ExitCode method), and 1 otherwise. A status that is not a
// normal exit (killed by a signal) is reported as 1.
func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	var ec interface{ ExitCode() int }
	if errors.As(err, &ec) {
		if c := ec.ExitCode(); c > 0 {
			return c
		}
	}
	return 1
}

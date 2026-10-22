package engine

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
)

// PhaseOrder is every phase id deploy-server.sh can emit, in script order.
// Some are conditional on the install mode; the checklist shows the superset.
// TestPhaseOrderMatchesScript keeps it in sync with the script.
var PhaseOrder = []string{
	"config", "validate", "docker", "ca", "caddy-render", "backend-env",
	"root-env", "firewall", "up", "ca-export", "bootstrap", "renew-timer",
}

// Runner runs scripts/deploy-server.sh from RepoRoot.
type Runner struct {
	RepoRoot     string
	ConfigPath   string
	InstallerBin string
	Env          []string // extra KEY=VALUE entries, added to os.Environ()
}

// Phases returns the ordered phase ids for the checklist.
func (r Runner) Phases() []string { return PhaseOrder }

// Start launches the script. Events arrive on the returned channel, which is
// closed once the output ends; the returned func then waits for the process
// and returns its error (an *exec.ExitError on non-zero exit). Cancelling ctx
// kills the whole process group.
func (r Runner) Start(ctx context.Context) (<-chan Event, func() error, error) {
	cmd := exec.CommandContext(ctx, "bash", "scripts/deploy-server.sh", r.ConfigPath)
	cmd.Dir = r.RepoRoot
	env := append(os.Environ(), r.Env...)
	// Fixed flags last so they win over anything inherited or passed in Env.
	cmd.Env = append(env,
		"ACHILLES_PROGRESS=1",
		"ACHILLES_NONINTERACTIVE=1",
		"ACHILLES_INSTALLER_BIN="+r.InstallerBin,
	)
	setProcessGroup(cmd)

	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	// One pipe for both streams keeps stdout/stderr in write order.
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, nil, err
	}
	pw.Close() // the child holds the only write end now

	events := make(chan Event, 64)
	done := make(chan struct{})
	var waitErr error
	go func() {
		defer close(done)
		defer pr.Close()
		br := bufio.NewReaderSize(pr, 64*1024)
		sending := true
		for {
			line, err := readLine(br)
			if line != "" || err == nil {
				if sending {
					select {
					case events <- ParseLine(line):
					case <-ctx.Done():
						sending = false // consumer gone; keep draining
					}
				}
			}
			if err != nil {
				break
			}
		}
		waitErr = cmd.Wait()
		close(events)
	}()
	return events, func() error { <-done; return waitErr }, nil
}

// readLine reads one full line of any length, without the trailing newline.
func readLine(br *bufio.Reader) (string, error) {
	var buf []byte
	for {
		chunk, isPrefix, err := br.ReadLine()
		buf = append(buf, chunk...)
		if err != nil {
			if err == io.EOF && len(buf) > 0 {
				return string(buf), nil
			}
			return string(buf), err
		}
		if !isPrefix {
			return string(buf), nil
		}
	}
}

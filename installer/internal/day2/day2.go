// Package day2 implements the commands an admin runs on an installed server:
// status, upgrade, backup and restore. Every docker and git call goes through
// the Cmd interface, so tests need neither docker, git nor a network.
package day2

import (
	"bufio"
	"context"
	"crypto/x509"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// DefaultBackupDir is where backups are written (mode 0700, files 0600).
const DefaultBackupDir = "/var/backups/projectachilles"

// helperImage runs tar against volumes for backup and restore. It is pinned
// to a release line rather than the floating "alpine" (latest) tag so a
// backup and a later restore run the same busybox tar, and a new Alpine
// major can't change what either does without a reviewed code change. 3.24
// was the newest 3.x line when this was written; bump it deliberately.
const helperImage = "alpine:3.24"

// Cmd runs an external program and returns its combined output.
type Cmd interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// ExecCmd is the real Cmd.
type ExecCmd struct{}

// Run implements Cmd. A failure carries the program's output.
func (ExecCmd) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, lastLines(msg, 5))
		}
		return out, fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return out, nil
}

func lastLines(s string, n int) string {
	l := strings.Split(s, "\n")
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return strings.Join(l, "\n")
}

// Deps is everything the day-2 commands touch.
type Deps struct {
	Cmd       Cmd
	RepoDir   string // the checkout (docker-compose.server.yml lives here)
	CADir     string // /etc/projectachilles/ca
	BackupDir string
	Out       io.Writer
	In        io.Reader
	Now       func() time.Time

	Host    string // AchillesDomain from deploy.config.env
	TLSMode string // TLS_MODE from deploy.config.env
	Project string // compose project name; derived from RepoDir when empty

	// Health fetches https://host/api/health. Nil means DefaultHealth.
	Health func(ctx context.Context, host string, roots *x509.CertPool) (HealthResult, error)
	// DiskFree reports free bytes on path. Nil means the OS default.
	DiskFree func(path string) (uint64, error)
	// RunEngine re-runs the install engine non-interactively with the
	// existing config, printing its progress. Upgrade only.
	RunEngine func(ctx context.Context) error
	// InstallerVersion is this binary's version (main.version). Upgrade
	// uses it to tell the operator how to update the installer itself.
	InstallerVersion string
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) out() io.Writer {
	if d.Out != nil {
		return d.Out
	}
	return io.Discard
}

func (d Deps) backupDir(override string) string {
	switch {
	case override != "":
		return override
	case d.BackupDir != "":
		return d.BackupDir
	}
	return DefaultBackupDir
}

var projectBad = regexp.MustCompile(`[^a-z0-9_-]`)

// project is the compose project name: the explicit one, COMPOSE_PROJECT_NAME,
// or the checkout directory's base name lowercased the way compose does it.
func (d Deps) project() string {
	if d.Project != "" {
		return d.Project
	}
	if p := os.Getenv("COMPOSE_PROJECT_NAME"); p != "" {
		return p
	}
	return projectBad.ReplaceAllString(strings.ToLower(filepath.Base(d.RepoDir)), "")
}

func (d Deps) composeFile() string { return filepath.Join(d.RepoDir, "docker-compose.server.yml") }

// compose runs `docker compose -f <file> <args…>`.
func (d Deps) compose(ctx context.Context, args ...string) ([]byte, error) {
	full := append([]string{"compose", "-f", d.composeFile()}, args...)
	return d.Cmd.Run(ctx, "docker", full...)
}

// git runs `git -C <repo> <args…>`.
func (d Deps) git(ctx context.Context, args ...string) ([]byte, error) {
	return d.Cmd.Run(ctx, "git", append([]string{"-C", d.RepoDir}, args...)...)
}

// readLine reads one line from r (without the newline).
func readLine(r *bufio.Reader) string {
	s, _ := r.ReadString('\n')
	return strings.TrimSpace(s)
}

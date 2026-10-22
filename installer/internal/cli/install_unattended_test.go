package cli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
)

type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit status %d", int(e)) }
func (e exitCode) ExitCode() int { return int(e) }

// scripted is a fake engine run.
type scripted struct {
	events []engine.Event
	err    error
}

func (s scripted) Start(ctx context.Context) (<-chan engine.Event, func() error, error) {
	ch := make(chan engine.Event)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(ch)
		for _, ev := range s.events {
			select {
			case ch <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, func() error { <-done; return s.err }, nil
}

type runnerCall struct{ root, cfgPath, caDir string }

type ioBufs struct{ out, err bytes.Buffer }

// unattendedRegistry registers install with a fake engine and no TTY. The
// handler's output lands in bufs.
func unattendedRegistry(t *testing.T, run scripted) (*Registry, *[]runnerCall, *ioBufs) {
	t.Helper()
	r := NewRegistry("dev")
	in, w, err := os.Pipe() // not a TTY: the unattended path must not need one
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); w.Close() })
	var calls []runnerCall
	bufs := &ioBufs{}
	registerInstall(r, installIO{
		stdin: in, stdout: &bufs.out, stderr: &bufs.err,
		getenv: func(string) string { return "" },
		newRunner: func(root, cfgPath, caDir string) (engine.Starter, error) {
			calls = append(calls, runnerCall{root, cfgPath, caDir})
			return run, nil
		},
	})
	return r, &calls, bufs
}

func validConfig(t *testing.T) string {
	t.Helper()
	c := config.Config{
		AchillesDomain: "achilles.corp.example.com", TLSMode: "achilles-ca", CaddyBindIP: "10.0.5.20",
		CAZone: "corp.example.com", ClerkPublishableKey: "pk_test_eA==", ClerkSecretKey: "sk_test_x",
	}
	p := filepath.Join(t.TempDir(), "deploy.config.env")
	if err := c.Write(p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNonInteractiveInstallExitCode(t *testing.T) {
	cfg := validConfig(t)
	repo := t.TempDir()
	r, calls, b := unattendedRegistry(t, scripted{
		events: []engine.Event{
			{Kind: engine.Phase, ID: "config", Text: "Loading configuration"},
			{Kind: engine.Log, Text: "  using " + cfg},
			{Kind: engine.OK, ID: "config"},
			{Kind: engine.Warn, Text: "ufw is inactive"},
			{Kind: engine.Phase, ID: "up", Text: "Building and starting the stack"},
			{Kind: engine.Fail, ID: "up", Text: "docker compose up failed"},
		},
		err: exitCode(3),
	})
	var out, errb bytes.Buffer
	code := r.Run([]string{"install", "--config", cfg, "--yes", "--repo", repo}, &out, &errb)
	if code != 3 {
		t.Fatalf("exit code = %d, want 3 (stderr %q)", code, errb.String())
	}
	got := b.out.String() + b.err.String()
	for _, want := range []string{
		"==> Loading configuration\n",
		"  using " + cfg + "\n",
		"  ✓ config\n",
		"  ! ufw is inactive\n",
		"==> Building and starting the stack\n",
		"error: docker compose up failed\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
	if len(*calls) != 1 || (*calls)[0].root != repo || (*calls)[0].cfgPath != cfg {
		t.Errorf("runner calls = %+v", *calls)
	}
}

func TestNonInteractiveInstallSuccess(t *testing.T) {
	cfg := validConfig(t)
	r, _, b := unattendedRegistry(t, scripted{events: []engine.Event{{Kind: engine.Phase, ID: "config", Text: "Loading configuration"}, {Kind: engine.OK, ID: "config"}}})
	var out, errb bytes.Buffer
	if code := r.Run([]string{"install", "--config", cfg, "--yes", "--repo", t.TempDir()}, &out, &errb); code != 0 {
		t.Fatalf("exit code = %d (stderr %q)", code, errb.String())
	}
	if want := "==> Loading configuration\n  ✓ config\nProjectAchilles is installed: https://achilles.corp.example.com\n"; b.out.String() != want {
		t.Fatalf("stdout = %q, want %q", b.out.String(), want)
	}
}

// A relative --config is resolved against the working directory, because
// the engine runs from the repo root.
func TestNonInteractiveRelativeConfigMadeAbsolute(t *testing.T) {
	cfg := validConfig(t)
	t.Chdir(filepath.Dir(cfg))
	r, calls, b := unattendedRegistry(t, scripted{})
	var out, errb bytes.Buffer
	if code := r.Run([]string{"install", "--config", filepath.Base(cfg), "--yes", "--repo", t.TempDir()}, &out, &errb); code != 0 {
		t.Fatalf("exit code = %d (stderr %q)", code, errb.String())
	}
	if got := (*calls)[0].cfgPath; got != cfg {
		t.Fatalf("engine config path = %q, want %q (output %q)", got, cfg, b.out.String())
	}
}

func TestNonInteractiveValidationProblems(t *testing.T) {
	p := filepath.Join(t.TempDir(), "deploy.config.env")
	bad := config.Config{AchillesDomain: "achilles.corp.example.com", TLSMode: "achilles-ca", OrganizationName: strings.Repeat("x", 57)}
	if err := bad.Write(p); err != nil {
		t.Fatal(err)
	}
	r, calls, b := unattendedRegistry(t, scripted{})
	var out, errb bytes.Buffer
	code := r.Run([]string{"install", "--config", p, "--yes", "--repo", t.TempDir()}, &out, &errb)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	for _, want := range []string{
		"CLERK_PUBLISHABLE_KEY: Clerk publishable key is required\n",
		"CLERK_SECRET_KEY: Clerk secret key is required\n",
		"CADDY_BIND_IP: LAN bind IP is required\n",
		"ORGANIZATION_NAME: must be at most 56 characters (got 57)\n",
	} {
		if !strings.Contains(b.err.String(), want) {
			t.Errorf("stderr missing %q:\n%s", want, b.err.String())
		}
	}
	if len(*calls) != 0 {
		t.Fatal("engine started despite validation problems")
	}
}

func TestNonInteractiveWithoutYesPrintsPlan(t *testing.T) {
	cfg := validConfig(t)
	repo := t.TempDir()
	r, calls, b := unattendedRegistry(t, scripted{})
	var out, errb bytes.Buffer
	code := r.Run([]string{"install", "--config", cfg, "--repo", repo}, &out, &errb)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	got := b.out.String()
	for _, want := range []string{"scripts/deploy-server.sh " + cfg, repo, "--yes"} {
		if !strings.Contains(got, want) {
			t.Errorf("plan missing %q:\n%s", want, got)
		}
	}
	if len(*calls) != 0 {
		t.Fatal("engine started without --yes")
	}
}

func TestNonInteractiveYesNeedsConfig(t *testing.T) {
	r, calls, _ := unattendedRegistry(t, scripted{})
	var out, errb bytes.Buffer
	if code := r.Run([]string{"install", "--yes"}, &out, &errb); code != 2 || !strings.Contains(errb.String(), "--config FILE") {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
	if len(*calls) != 0 {
		t.Fatal("engine started")
	}
}

func TestNonInteractiveMissingConfigFile(t *testing.T) {
	r, calls, _ := unattendedRegistry(t, scripted{})
	var out, errb bytes.Buffer
	if code := r.Run([]string{"install", "--config", filepath.Join(t.TempDir(), "nope.env"), "--yes"}, &out, &errb); code != 1 {
		t.Fatalf("code=%d stderr=%q", code, errb.String())
	}
	if len(*calls) != 0 {
		t.Fatal("engine started")
	}
}

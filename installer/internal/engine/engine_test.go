package engine

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestParseLine(t *testing.T) {
	tests := []struct {
		name string
		line string
		want Event
	}{
		{"phase", "::phase validate Validating settings", Event{Kind: Phase, ID: "validate", Text: "Validating settings"}},
		{"phase extra spaces", "::phase  caddy-render   Configuring  Caddy TLS  ", Event{Kind: Phase, ID: "caddy-render", Text: "Configuring  Caddy TLS"}},
		{"ok", "::ok validate", Event{Kind: OK, ID: "validate"}},
		{"warn", "::warn disk is almost full", Event{Kind: Warn, Text: "disk is almost full"}},
		{"fail", "::fail up compose exited 1", Event{Kind: Fail, ID: "up", Text: "compose exited 1"}},
		{"fail no message", "::fail up", Event{Kind: Fail, ID: "up"}},
		{"bogus", "::bogus x y", Event{Kind: Log, Text: "::bogus x y"}},
		{"phase without id", "::phase", Event{Kind: Log, Text: "::phase"}},
		{"ok bad id", "::ok Bad_ID", Event{Kind: Log, Text: "::ok Bad_ID"}},
		{"plain", "Pulling image caddy", Event{Kind: Log, Text: "Pulling image caddy"}},
		{"not at line start", "x ::ok validate", Event{Kind: Log, Text: "x ::ok validate"}},
		{"carriage return", "::ok docker\r", Event{Kind: OK, ID: "docker"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseLine(tc.line); got != tc.want {
				t.Fatalf("ParseLine(%q) = %+v, want %+v", tc.line, got, tc.want)
			}
		})
	}
}

func fakeRepo(t *testing.T, script string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "scripts", "deploy-server.sh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func collect(t *testing.T, ch <-chan Event) []Event {
	t.Helper()
	var evs []Event
	timeout := time.After(20 * time.Second)
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return evs
			}
			evs = append(evs, e)
		case <-timeout:
			t.Fatal("timed out waiting for events")
		}
	}
}

func TestRunnerStreamsEventsAndExitCode(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
echo "::phase config Loading"
echo "hello"
echo "::ok config"
echo "to stderr" >&2
echo "::fail up boom"
exit 3
`)
	r := Runner{RepoRoot: root, ConfigPath: "cfg.env", InstallerBin: "/bin/true"}
	ch, wait, err := r.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, ch)
	want := []Event{
		{Kind: Phase, ID: "config", Text: "Loading"},
		{Kind: Log, Text: "hello"},
		{Kind: OK, ID: "config"},
		{Kind: Log, Text: "to stderr"},
		{Kind: Fail, ID: "up", Text: "boom"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %+v\nwant %+v", got, want)
	}
	var ee *exec.ExitError
	if err := wait(); !errors.As(err, &ee) || ee.ExitCode() != 3 {
		t.Fatalf("wait() = %v, want ExitError code 3", err)
	}
}

func TestRunnerPassesArgsAndEnv(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
echo "arg=$1 cwd=$(pwd -P) p=$ACHILLES_PROGRESS n=$ACHILLES_NONINTERACTIVE b=$ACHILLES_INSTALLER_BIN x=$EXTRA"
`)
	r := Runner{RepoRoot: root, ConfigPath: "/etc/cfg.env", InstallerBin: "/opt/inst",
		Env: []string{"EXTRA=1", "ACHILLES_PROGRESS=0"}}
	ch, wait, err := r.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, ch)
	if err := wait(); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(root)
	want := "arg=/etc/cfg.env cwd=" + real + " p=1 n=1 b=/opt/inst x=1"
	if len(got) != 1 || got[0].Kind != Log || got[0].Text != want {
		t.Fatalf("got %+v, want log %q", got, want)
	}
}

func TestRunnerHandlesLongLines(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
head -c 300000 /dev/zero | tr '\0' 'a'; echo
echo "::ok config"
`)
	ch, wait, err := Runner{RepoRoot: root, ConfigPath: "c"}.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, ch)
	if err := wait(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Kind != Log || len(got[0].Text) != 300000 || got[1].Kind != OK {
		t.Fatalf("unexpected events (%d)", len(got))
	}
}

func TestRunnerCancelKillsProcessGroup(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
sleep 300 &
echo "child=$!"
wait
`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, wait, err := Runner{RepoRoot: root, ConfigPath: "c"}.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	e := <-ch
	pid := strings.TrimPrefix(e.Text, "child=")
	cancel()
	collect(t, ch)
	if err := wait(); err == nil {
		t.Fatal("expected error after cancel")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat("/proc/" + pid); err != nil {
			return
		}
		// zombie reaped by init may lag; check state
		b, _ := os.ReadFile("/proc/" + pid + "/stat")
		if strings.Contains(string(b), ") Z ") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("child sleep %s still running after cancel", pid)
}

func TestPhaseOrderMatchesScript(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(repoRoot(t), "scripts", "deploy-server.sh"))
	if err != nil {
		t.Fatal(err)
	}
	callRe := regexp.MustCompile(`^\s*phase ([a-z0-9-]+) "`)
	seen := map[string]bool{}
	var ids []string
	for _, line := range strings.Split(string(data), "\n") {
		if m := callRe.FindStringSubmatch(line); m != nil && !seen[m[1]] {
			seen[m[1]] = true
			ids = append(ids, m[1])
		}
	}
	if !reflect.DeepEqual(ids, PhaseOrder) {
		t.Fatalf("script phases %v != PhaseOrder %v", ids, PhaseOrder)
	}
	if got := (Runner{}).Phases(); !reflect.DeepEqual(got, PhaseOrder) {
		t.Fatalf("Phases() = %v", got)
	}
}

func TestRunnerDoesNotHangOnEscapedDescendant(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
setsid sleep 300 >&1 2>&1 &
echo "child=$!"
exit 0
`)
	ch, wait, err := Runner{RepoRoot: root, ConfigPath: "c"}.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e := <-ch
	pid := strings.TrimPrefix(e.Text, "child=")
	defer exec.Command("kill", pid).Run()
	start := time.Now()
	collect(t, ch) // must close despite the descendant holding the pipe
	if err := wait(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 6*time.Second {
		t.Fatalf("took %v", d)
	}
}

func TestRunnerWaitSafeWithoutReading(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
for i in $(seq 1 500); do echo "line $i"; done
`)
	ctx, cancel := context.WithCancel(context.Background())
	_, wait, err := Runner{RepoRoot: root, ConfigPath: "c"}.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel() // consumer walks away without reading
	finished := make(chan struct{})
	go func() { wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("wait hung")
	}
}

func TestRunnerWaitWithoutCancelOrReading(t *testing.T) {
	root := fakeRepo(t, `#!/usr/bin/env bash
for i in $(seq 1 500); do echo "line $i"; done
`)
	_, wait, err := Runner{RepoRoot: root, ConfigPath: "c"}.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	go func() { wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("wait hung")
	}
}

package cli

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
)

func installRegistry(t *testing.T, term string) (*Registry, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	r := NewRegistry("dev")
	var out, errb bytes.Buffer
	in, w, err := os.Pipe() // not a TTY
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); w.Close() })
	registerInstall(r, installIO{
		stdin: in, stdout: w, stderr: &errb,
		getenv: func(k string) string {
			if k == "TERM" {
				return term
			}
			return ""
		},
	})
	return r, &out, &errb
}

func TestInstallRefusesWithoutTTY(t *testing.T) {
	for _, term := range []string{"xterm-256color", "dumb"} {
		r, _, errb := installRegistry(t, term)
		code := r.Run([]string{"install"}, &bytes.Buffer{}, errb)
		if code == 0 {
			t.Fatalf("TERM=%s: exit 0 without a TTY", term)
		}
		if !strings.Contains(errb.String(), "install --config FILE --yes") {
			t.Errorf("TERM=%s: stderr %q does not point to install --config FILE --yes", term, errb)
		}
	}
}

func TestInstallNoArgsIsInstall(t *testing.T) {
	r, _, errb := installRegistry(t, "xterm")
	if code := r.Run(nil, &bytes.Buffer{}, errb); code == 0 || !strings.Contains(errb.String(), "--config FILE --yes") {
		t.Fatalf("code=%d stderr=%q", code, errb)
	}
}

func TestInstallRejectsStrayArgs(t *testing.T) {
	r, _, errb := installRegistry(t, "xterm")
	if code := r.Run([]string{"install", "extra"}, &bytes.Buffer{}, errb); code == 0 {
		t.Fatalf("stray argument accepted: %q", errb)
	}
}

// The wizard's Upgrade/Status choice hands off with the wizard's own --repo
// and --ca-dir; without them the command would act on the default checkout
// and CA directory.
func TestInstallHandOffKeepsRepoAndCADir(t *testing.T) {
	for _, name := range []string{"upgrade", "status"} {
		r := NewRegistry("dev")
		var got []string
		r.Register(name, func(_ context.Context, args []string) error {
			got = args
			return nil
		})
		if err := handOff(r, name, "/srv/pa", "/srv/ca", &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if want := "--repo /srv/pa --ca-dir /srv/ca"; strings.Join(got, " ") != want {
			t.Errorf("%s hand-off args = %q, want %q", name, got, want)
		}
	}
}

// The real day-2 commands accept the hand-off's flags.
func TestDay2CommandsAcceptHandOffFlags(t *testing.T) {
	r := NewRegistry("dev")
	var errb bytes.Buffer
	registerDay2(r, day2IO{stdin: strings.NewReader(""), stdout: &bytes.Buffer{}, stderr: &errb, cmd: failCmd{}, tty: func() bool { return false }})
	for _, name := range []string{"upgrade", "status"} {
		errb.Reset()
		r.Run([]string{name, "--repo", t.TempDir(), "--ca-dir", t.TempDir()}, &bytes.Buffer{}, &errb)
		if strings.Contains(errb.String(), "flag provided but not defined") {
			t.Errorf("%s rejects the hand-off flags: %s", name, errb.String())
		}
	}
}

package cli

import (
	"bytes"
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

func TestInstallUnattendedNotImplementedYet(t *testing.T) {
	for _, args := range [][]string{
		{"install", "--config", "deploy.config.env", "--yes"},
		{"install", "--yes"},
		{"install", "--config", "x.env"},
	} {
		r, _, errb := installRegistry(t, "xterm")
		code := r.Run(args, &bytes.Buffer{}, errb)
		if code == 0 || !strings.Contains(errb.String(), "not implemented yet") {
			t.Errorf("%v: code=%d stderr=%q", args, code, errb)
		}
	}
}

func TestInstallRejectsStrayArgs(t *testing.T) {
	r, _, errb := installRegistry(t, "xterm")
	if code := r.Run([]string{"install", "extra"}, &bytes.Buffer{}, errb); code == 0 {
		t.Fatalf("stray argument accepted: %q", errb)
	}
}

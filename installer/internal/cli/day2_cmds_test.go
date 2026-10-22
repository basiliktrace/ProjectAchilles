package cli

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

type failCmd struct{}

func (failCmd) Run(context.Context, string, ...string) ([]byte, error) {
	return nil, errors.New("docker: not running")
}

func TestStatusExitsOneWhenUnhealthy(t *testing.T) {
	var out, errb bytes.Buffer
	r := NewRegistry("test")
	registerDay2(r, day2IO{stdin: strings.NewReader(""), stdout: &out, stderr: &errb, cmd: failCmd{}})
	code := r.Run([]string{"status", "--repo", t.TempDir(), "--ca-dir", t.TempDir() + "/none"}, &out, &errb)
	if code != 1 {
		t.Fatalf("exit %d, want 1; out=%s", code, out.String())
	}
	if !strings.Contains(out.String(), "unavailable") {
		t.Fatalf("out: %s", out.String())
	}
}

func TestRestoreNeedsFile(t *testing.T) {
	var out, errb bytes.Buffer
	r := NewRegistry("test")
	registerDay2(r, day2IO{stdin: strings.NewReader(""), stdout: &out, stderr: &errb, cmd: failCmd{}})
	if code := r.Run([]string{"restore"}, &out, &errb); code == 0 {
		t.Fatal("restore without FILE must fail")
	}
}

package cli

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"
)

func run(r *Registry, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := r.Run(args, &out, &errb)
	return code, out.String(), errb.String()
}

func TestRunUnknownCommandExits2(t *testing.T) {
	r := NewRegistry("dev")
	code, _, stderr := run(r, "bogus")
	if code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if !strings.Contains(stderr, "Usage") {
		t.Fatalf("stderr missing usage: %q", stderr)
	}
}

func TestRunVersionPrintsVersion(t *testing.T) {
	r := NewRegistry("1.2.3")
	code, stdout, _ := run(r, "version")
	if code != 0 || !strings.Contains(stdout, "1.2.3") {
		t.Fatalf("code=%d stdout=%q", code, stdout)
	}
}

func TestRunNoArgsDispatchesInstall(t *testing.T) {
	r := NewRegistry("dev")
	called := false
	r.Register("install", func(ctx context.Context, args []string) error {
		called = true
		return nil
	})
	if code, _, _ := run(r); code != 0 || !called {
		t.Fatalf("code=%d called=%v", code, called)
	}
}

func TestRunCaSubcommandDispatch(t *testing.T) {
	r := NewRegistry("dev")
	var got []string
	r.Register("ca init", func(ctx context.Context, args []string) error {
		got = args
		return nil
	})
	code, _, _ := run(r, "ca", "init", "--org", "Acme")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if want := []string{"--org", "Acme"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
}

func TestRunHandlerErrorExits1(t *testing.T) {
	r := NewRegistry("dev")
	r.Register("status", func(ctx context.Context, args []string) error {
		return errString("boom")
	})
	code, _, stderr := run(r, "status")
	if code != 1 || !strings.Contains(stderr, "boom") {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
}

type errString string

func (e errString) Error() string { return string(e) }

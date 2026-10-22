package cli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func fakeCheckout(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "scripts", "deploy-server.sh"), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPickRepoDir(t *testing.T) {
	checkoutWD, checkoutExe, plain := fakeCheckout(t), fakeCheckout(t), t.TempDir()
	at := func(p string) func() (string, error) { return func() (string, error) { return p, nil } }
	fail := func() (string, error) { return "", errors.New("unavailable") }
	exeIn := func(dir string) func() (string, error) { return at(filepath.Join(dir, "achilles-installer")) }

	for _, tc := range []struct {
		name       string
		flag       string
		getwd, exe func() (string, error)
		want       string
	}{
		{"flag wins", "/srv/pa", at(checkoutWD), exeIn(checkoutExe), "/srv/pa"},
		{"working directory checkout", "", at(checkoutWD), exeIn(checkoutExe), checkoutWD},
		// install-onprem.sh --dir /srv/pa, then the binary run from elsewhere.
		{"binary's directory checkout", "", at(plain), exeIn(checkoutExe), checkoutExe},
		{"binary not in a checkout", "", at(plain), exeIn(plain), defaultRepoDir},
		{"nothing resolvable", "", fail, fail, defaultRepoDir},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := pickRepoDir(tc.flag, tc.getwd, tc.exe); got != tc.want {
				t.Errorf("pickRepoDir = %q, want %q", got, tc.want)
			}
		})
	}
}

// A symlinked binary (e.g. /usr/local/bin/achilles-installer) resolves to
// the checkout it points into.
func TestPickRepoDirFollowsSymlink(t *testing.T) {
	checkout, elsewhere := fakeCheckout(t), t.TempDir()
	real := filepath.Join(checkout, "achilles-installer")
	if err := os.WriteFile(real, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(elsewhere, "achilles-installer")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlinks unsupported:", err)
	}
	got := pickRepoDir("", func() (string, error) { return elsewhere, nil }, func() (string, error) { return link, nil })
	// t.TempDir may itself sit behind a symlink (macOS /var); compare resolved.
	want, _ := filepath.EvalSymlinks(checkout)
	if got != want && got != checkout {
		t.Errorf("pickRepoDir = %q, want %q", got, checkout)
	}
}

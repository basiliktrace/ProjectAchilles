package engine

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// scripts/install-onprem.sh, sourced with ACHILLES_SOURCE_ONLY=1 so single
// functions run against a temp git checkout.

// gitRepo makes a checkout with a committed deploy/caddy/tls.caddy.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "deploy", "caddy", "tls.caddy"), "tls internal\n", 0o644)
	writeFile(t, filepath.Join(dir, "README.md"), "readme\n", 0o644)
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "."},
		{"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

// ensureCleanTree runs install-onprem.sh's ensure_clean_tree on dir.
func ensureCleanTree(t *testing.T, dir string) (string, error) {
	t.Helper()
	script := filepath.Join(repoRoot(t), "scripts", "install-onprem.sh")
	cmd := exec.Command("bash", "-c", `source "$1"; DIR="$2"; ensure_clean_tree`, "_", script, dir)
	cmd.Env = append(os.Environ(), "ACHILLES_SOURCE_ONLY=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

func TestInstallOnpremCleanTree(t *testing.T) {
	const tlsCaddy = "deploy/caddy/tls.caddy"
	const oldEngine = "tls {\n\tdns cloudflare {env.CADDY_DNS_TOKEN}\n}\n" // what a pre-installer engine wrote

	t.Run("clean checkout passes untouched", func(t *testing.T) {
		dir := gitRepo(t)
		out, err := ensureCleanTree(t, dir)
		if err != nil || strings.Contains(out, "Restored") {
			t.Fatalf("err=%v out=%q", err, out)
		}
	})

	// A pre-installer install: the old engine overwrote the tracked tls.caddy.
	t.Run("only tls.caddy modified is restored", func(t *testing.T) {
		dir := gitRepo(t)
		writeFile(t, filepath.Join(dir, tlsCaddy), oldEngine, 0o644)
		out, err := ensureCleanTree(t, dir)
		if err != nil {
			t.Fatalf("refused a checkout whose only change is %s: %v\n%s", tlsCaddy, err, out)
		}
		if got := readFile(t, filepath.Join(dir, tlsCaddy)); got != "tls internal\n" {
			t.Errorf("%s not restored: %q", tlsCaddy, got)
		}
		if !strings.Contains(out, "Restored "+tlsCaddy) {
			t.Errorf("no restore message: %q", out)
		}
	})

	for name, dirty := range map[string]func(t *testing.T, dir string){
		"another tracked file modified": func(t *testing.T, dir string) {
			writeFile(t, filepath.Join(dir, "README.md"), "local edit\n", 0o644)
		},
		"an untracked file": func(t *testing.T, dir string) {
			writeFile(t, filepath.Join(dir, "notes.txt"), "x\n", 0o644)
		},
	} {
		t.Run(name+" is refused and tls.caddy left alone", func(t *testing.T) {
			dir := gitRepo(t)
			writeFile(t, filepath.Join(dir, tlsCaddy), oldEngine, 0o644)
			dirty(t, dir)
			out, err := ensureCleanTree(t, dir)
			if err == nil {
				t.Fatalf("accepted a dirty checkout:\n%s", out)
			}
			// The running pre-installer stack still mounts tls.caddy.
			if got := readFile(t, filepath.Join(dir, tlsCaddy)); got != oldEngine {
				t.Errorf("%s changed on a refused run: %q", tlsCaddy, got)
			}
			for _, want := range []string{"has local changes", "stash", dir + "/scripts/deploy-server.sh as before"} {
				if !strings.Contains(out, want) {
					t.Errorf("message lacks %q:\n%s", want, out)
				}
			}
			if strings.Contains(out, "achilles-installer upgrade") {
				t.Errorf("message points at the upgrade command, which refuses a dirty tree too:\n%s", out)
			}
			if strings.Contains(out, tlsCaddy) {
				t.Errorf("message lists %s, which the script handles itself:\n%s", tlsCaddy, out)
			}
		})
	}
}

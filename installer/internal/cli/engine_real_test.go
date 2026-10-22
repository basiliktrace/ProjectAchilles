package cli

// The unattended install against the real scripts/deploy-server.sh in
// render-only mode, in a scratch copy of the repo.

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
)

func renderOnlyRepo(t *testing.T) (root, cfg string, env []string) {
	t.Helper()
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	root = t.TempDir()
	copyFile := func(rel string, mode fs.FileMode) {
		b, err := os.ReadFile(filepath.Join(repo, rel))
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, mode); err != nil {
			t.Fatal(err)
		}
	}
	copyFile("scripts/deploy-server.sh", 0o755)
	copyFile("docker-compose.server.yml", 0o644)
	err = filepath.WalkDir(filepath.Join(repo, "deploy", "caddy"), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(repo, p)
		copyFile(rel, 0o644)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "backend"), 0o755); err != nil {
		t.Fatal(err)
	}
	td := filepath.Join(repo, "installer", "internal", "engine", "testdata", "configs")
	a, _ := os.ReadFile(filepath.Join(td, "acme-http.env"))
	c, _ := os.ReadFile(filepath.Join(td, "common.env"))
	cfg = filepath.Join(root, "deploy.config.env")
	if err := os.WriteFile(cfg, append(a, c...), 0o600); err != nil {
		t.Fatal(err)
	}
	env = []string{"ACHILLES_RENDER_ONLY=1", "HOME=" + root, "ACHILLES_CA_DIR_OVERRIDE=" + filepath.Join(root, "ca")}
	return root, cfg, env
}

func TestNonInteractiveRealEngineNoDuplicatesOrEscapes(t *testing.T) {
	root, cfg, env := renderOnlyRepo(t)
	r := NewRegistry("dev")
	in, w, err := os.Pipe() // no TTY
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); w.Close() })
	var out, errb bytes.Buffer
	registerInstall(r, installIO{
		stdin: in, stdout: &out, stderr: &errb,
		getenv: func(string) string { return "" },
		newRunner: func(root, cfgPath, caDir string) (engine.Starter, error) {
			s, err := engineRunner(root, cfgPath, caDir) // the real runner
			if err != nil {
				return nil, err
			}
			rr := s.(engine.Runner)
			rr.Env = append(rr.Env, env...)
			return rr, nil
		},
	})
	if code := r.Run([]string{"install", "--config", cfg, "--yes", "--repo", root}, &bytes.Buffer{}, &bytes.Buffer{}); code != 0 {
		t.Fatalf("exit %d\nstdout:\n%s\nstderr:\n%s", code, out.String(), errb.String())
	}
	all := out.String() + errb.String()
	for _, title := range []string{"Loading configuration", "Validating settings", "Configuring Caddy TLS (acme-http)", "Writing backend/.env", "Writing root .env"} {
		if n := strings.Count(all, title); n != 1 {
			t.Errorf("%q appears %d times, want 1:\n%s", title, n, all)
		}
		if !strings.Contains(out.String(), "==> "+title+"\n") {
			t.Errorf("missing phase line %q:\n%s", "==> "+title, all)
		}
	}
	if strings.ContainsRune(all, 0x1b) {
		t.Errorf("escape sequence in the output:\n%q", all)
	}
}

package tui

// The install screen against the real scripts/deploy-server.sh in
// render-only mode, in a scratch copy of the repo.

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
)

// renderOnlyRepo copies what deploy-server.sh reads into a temp repo and
// writes an acme-http config there (acme-http render-only needs no
// installer binary, no Docker and no root).
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
	cfg = filepath.Join(root, "engine.env")
	if err := os.WriteFile(cfg, append(a, c...), 0o600); err != nil {
		t.Fatal(err)
	}
	env = []string{"ACHILLES_RENDER_ONLY=1", "HOME=" + root, "ACHILLES_CA_DIR_OVERRIDE=" + filepath.Join(root, "ca")}
	return root, cfg, env
}

// renderOnlyTitles are the phase titles an acme-http render-only run emits.
var renderOnlyTitles = []string{"Loading configuration", "Validating settings", "Configuring Caddy TLS (acme-http)", "Writing backend/.env", "Writing root .env"}

func TestInstallRealEngineLogHasNoDuplicatesOrEscapes(t *testing.T) {
	root, cfg, env := renderOnlyRepo(t)
	deps := testDeps(t)
	deps.Runner = func(config.Config) engine.Starter {
		// The wizard's own answers are written to deps.ConfigPath; the run
		// uses the fixed render-only config.
		return engine.Runner{RepoRoot: root, ConfigPath: cfg, Env: env}
	}
	d := start(t, deps, nil)
	d.toReview()
	d.enter()
	d.waitText("Install complete")
	ch := make(chan []string, 1)
	d.tm.Send(probeMsg{fn: func(a *App) {
		for _, sc := range a.screens {
			if in, ok := sc.(*installScreen); ok {
				ch <- append([]string(nil), in.log.all()...)
			}
		}
	}})
	log := strings.Join(<-ch, "\n")
	for _, title := range renderOnlyTitles {
		if n := strings.Count(log, title); n != 1 {
			t.Errorf("%q appears %d times in the log, want 1:\n%s", title, n, log)
		}
	}
	if strings.ContainsRune(log, 0x1b) {
		t.Errorf("escape sequence in the log:\n%q", log)
	}
	d.quit()
}

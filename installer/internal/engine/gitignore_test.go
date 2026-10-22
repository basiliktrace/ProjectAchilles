package engine

import (
	"os/exec"
	"testing"
)

// Everything the engine (or `ca bootstrap`, or the enterprise-CA wizard step)
// writes into the checkout must be gitignored: `upgrade` and a re-run of
// install-onprem.sh refuse to touch a dirty tree.
func TestGeneratedOutputsAreGitignored(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := repoRoot(t)
	for _, p := range []string{
		"deploy/caddy/rendered/tls.caddy",
		"deploy/caddy/rendered/global.caddy",
		"deploy/caddy/rendered/sites-extra.caddy",
		"deploy/onprem/bootstrap-windows.ps1",
		"deploy/onprem/bootstrap-unix.sh",
		"deploy/caddy/certs/cert.pem",
		"deploy/caddy/certs/key.pem",
		"deploy/caddy/certs/request.csr",
		"deploy/caddy/certs/request.key",
		"deploy.config.env",
	} {
		if err := exec.Command("git", "-C", repo, "check-ignore", "-q", "--no-index", p).Run(); err != nil {
			t.Errorf("%s is not gitignored (git check-ignore: %v)", p, err)
		}
	}
}

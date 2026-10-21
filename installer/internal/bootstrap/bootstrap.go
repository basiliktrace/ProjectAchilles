// Package bootstrap renders the fingerprint-pinned endpoint bootstrap scripts.
package bootstrap

import (
	"bytes"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"text/template"

	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
)

//go:embed templates/*.tmpl
var templates embed.FS

// Params are the values pinned into the scripts.
type Params struct {
	Host       string // server DNS name
	RootSHA256 string // lowercase hex, no colons, of the DER root certificate
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Render writes bootstrap-windows.ps1 and bootstrap-unix.sh (mode 0644) into
// outDir, creating it (0755) if needed. Host and hash are validated first, so
// the values substituted into the scripts contain only [a-z0-9.-] / hex.
func Render(p Params, outDir string) (winPath, unixPath string, err error) {
	host, err := dnsclass.Normalize(p.Host)
	if err != nil {
		return "", "", fmt.Errorf("bootstrap host: %w", err)
	}
	if !sha256Hex.MatchString(p.RootSHA256) {
		return "", "", fmt.Errorf("bootstrap root SHA-256 must be 64 lowercase hex characters")
	}
	p = Params{Host: host, RootSHA256: p.RootSHA256}

	files := []struct{ tmpl, out string }{
		{"templates/bootstrap-windows.ps1.tmpl", "bootstrap-windows.ps1"},
		{"templates/bootstrap-unix.sh.tmpl", "bootstrap-unix.sh"},
	}
	rendered := make([][]byte, len(files))
	for i, f := range files {
		t, err := template.ParseFS(templates, f.tmpl)
		if err != nil {
			return "", "", err
		}
		var buf bytes.Buffer
		if err := t.Execute(&buf, p); err != nil {
			return "", "", fmt.Errorf("render %s: %w", f.out, err)
		}
		rendered[i] = buf.Bytes()
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", "", err
	}
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = filepath.Join(outDir, f.out)
		if err := os.WriteFile(paths[i], rendered[i], 0o644); err != nil {
			return "", "", err
		}
		if err := os.Chmod(paths[i], 0o644); err != nil {
			return "", "", err
		}
	}
	return paths[0], paths[1], nil
}

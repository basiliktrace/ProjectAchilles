package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func caRegistry() (*Registry, *bytes.Buffer, *bytes.Buffer) {
	r := NewRegistry("dev")
	var out, errb bytes.Buffer
	registerCA(r, &out, &errb)
	return r, &out, &errb
}

func TestParseExpiry(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"180d": 180 * 24 * time.Hour,
		"1.5d": 36 * time.Hour,
		"36h":  36 * time.Hour,
		"90m":  90 * time.Minute,
		"0d":   0,
	} {
		got, err := parseExpiry(in)
		if err != nil || got != want {
			t.Errorf("parseExpiry(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "d", "-5d", "-1h", "180", "abc", "1e400d"} {
		if _, err := parseExpiry(bad); err == nil {
			t.Errorf("parseExpiry(%q): want error", bad)
		}
	}
}

func TestCAInitPrintsFingerprints(t *testing.T) {
	r, out, errb := caRegistry()
	dir := filepath.Join(t.TempDir(), "ca")
	code := r.Run([]string{"ca", "init", "--dir", dir, "--zone", "corp.example.com", "--ip", "10.0.5.20", "--include-ip", "--label", "Acme"}, out, errb)
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, errb)
	}
	s := out.String()
	if !regexp.MustCompile(`SHA-256: ([0-9A-F]{2}:){31}[0-9A-F]{2}`).MatchString(s) {
		t.Errorf("no SHA-256 fingerprint in %q", s)
	}
	if !regexp.MustCompile(`SHA-1 thumbprint: [0-9A-F]{40}`).MatchString(s) {
		t.Errorf("no SHA-1 thumbprint in %q", s)
	}
	if !strings.Contains(s, "10.0.5.20") || !strings.Contains(s, "corp.example.com") {
		t.Errorf("constraints not shown in %q", s)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "root.cer")); err != nil {
		t.Error(err)
	}

	// Re-run with another zone refuses with a hint; --rotate replaces and warns.
	out.Reset()
	errb.Reset()
	if code := r.Run([]string{"ca", "init", "--dir", dir, "--zone", "other.example.com"}, out, errb); code == 0 {
		t.Fatal("zone change without --rotate succeeded")
	}
	if code := r.Run([]string{"ca", "init", "--dir", dir, "--zone", "other.example.com", "--rotate"}, out, errb); code != 0 {
		t.Fatalf("rotate exit %d, stderr %q", code, errb)
	}
	if !strings.Contains(errb.String(), "re-trust") {
		t.Errorf("rotate did not warn: %q", errb)
	}
}

func TestCAInitFlagValidation(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ca")
	for _, args := range [][]string{
		{"ca", "init", "--dir", dir}, // no zone
		{"ca", "init", "--dir", dir, "--zone", "corp.example.com", "--include-ip"}, // no ip
		{"ca", "init", "--dir", dir, "--zone", "corp.example.com", "extra"},        // stray arg
		{"ca", "init", "--dir", dir, "--zone", "corp.example.com", "--bogus"},
	} {
		r, out, errb := caRegistry()
		if code := r.Run(args, out, errb); code == 0 {
			t.Errorf("%v: exit 0", args)
		}
	}
	if _, err := os.Stat(dir); err == nil {
		t.Error("CA dir created by an invalid invocation")
	}
}

func TestCARenewAndExport(t *testing.T) {
	r, out, errb := caRegistry()
	dir := filepath.Join(t.TempDir(), "ca")
	if code := r.Run([]string{"ca", "init", "--dir", dir, "--zone", "corp.example.com"}, out, errb); code != 0 {
		t.Fatalf("init exit %d: %s", code, errb)
	}
	out.Reset()
	if code := r.Run([]string{"ca", "renew", "--dir", dir, "--if-expiring", "180d"}, out, errb); code != 0 {
		t.Fatalf("renew exit %d: %s", code, errb)
	}
	if strings.TrimSpace(out.String()) != "not due" {
		t.Errorf("renew output %q, want \"not due\"", out)
	}
	out.Reset()
	// 3 years is longer than the intermediate's lifetime, so it is due.
	if code := r.Run([]string{"ca", "renew", "--dir", dir, "--if-expiring", "1095d"}, out, errb); code != 0 {
		t.Fatalf("renew exit %d: %s", code, errb)
	}
	if strings.TrimSpace(out.String()) != "renewed" {
		t.Errorf("renew output %q, want \"renewed\"", out)
	}
	if code := r.Run([]string{"ca", "renew", "--dir", dir, "--if-expiring", "soon"}, out, errb); code == 0 {
		t.Error("bad --if-expiring accepted")
	}

	exp := filepath.Join(t.TempDir(), "export")
	out.Reset()
	if code := r.Run([]string{"ca", "export", "--dir", dir, "--out", exp}, out, errb); code != 0 {
		t.Fatalf("export exit %d: %s", code, errb)
	}
	for _, f := range []string{"root.crt", "root.cer"} {
		if _, err := os.Stat(filepath.Join(exp, f)); err != nil {
			t.Error(err)
		}
	}
	if !strings.Contains(out.String(), "SHA-256:") {
		t.Errorf("export did not print fingerprint: %q", out)
	}
	if code := r.Run([]string{"ca", "export", "--dir", dir}, out, errb); code == 0 {
		t.Error("export without --out succeeded")
	}
}

func TestCACommandsRegisteredOnDefaultRegistry(t *testing.T) {
	for _, name := range []string{"ca init", "ca renew", "ca export"} {
		if defaultRegistry.handlers[name] == nil {
			t.Errorf("%s not registered", name)
		}
	}
}

func TestCLICaBootstrapWritesBothFiles(t *testing.T) {
	r, out, errb := caRegistry()
	dir := filepath.Join(t.TempDir(), "ca")
	if code := r.Run([]string{"ca", "init", "--dir", dir, "--zone", "corp.example.com", "--label", "Acme"}, out, errb); code != 0 {
		t.Fatalf("init exit %d, %q", code, errb)
	}
	outDir := filepath.Join(t.TempDir(), "onprem")
	code := r.Run([]string{"ca", "bootstrap", "--dir", dir, "--host", "achilles.corp.example.com", "--out", outDir}, out, errb)
	if code != 0 {
		t.Fatalf("bootstrap exit %d, %q", code, errb)
	}
	m := regexp.MustCompile(`SHA-256: ([0-9A-F:]{95})`).FindStringSubmatch(out.String())
	if m == nil {
		t.Fatalf("no fingerprint printed: %q", out)
	}
	want := strings.ToLower(strings.ReplaceAll(m[1], ":", ""))
	for _, f := range []string{"bootstrap-windows.ps1", "bootstrap-unix.sh"} {
		b, err := os.ReadFile(filepath.Join(outDir, f))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), want) {
			t.Errorf("%s lacks fingerprint %s", f, want)
		}
	}
}

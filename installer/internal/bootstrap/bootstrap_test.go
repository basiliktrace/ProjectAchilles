package bootstrap

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const (
	testHost = "achilles.corp.example.com"
	testHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func render(t *testing.T) (win, unix string) {
	t.Helper()
	w, u, err := Render(Params{Host: testHost, RootSHA256: testHash}, filepath.Join(t.TempDir(), "out"))
	if err != nil {
		t.Fatal(err)
	}
	wb, err := os.ReadFile(w)
	if err != nil {
		t.Fatal(err)
	}
	ub, err := os.ReadFile(u)
	if err != nil {
		t.Fatal(err)
	}
	return string(wb), string(ub)
}

func TestRenderWindowsPinsFingerprintAndHost(t *testing.T) {
	win, unix := render(t)
	for name, s := range map[string]string{"windows": win, "unix": unix} {
		if !strings.Contains(s, testHash) {
			t.Errorf("%s: pinned hash missing", name)
		}
		for _, u := range []string{
			"http://" + testHost + "/ca/root.cer",
			"https://" + testHost + "/api/agent/download?os=",
		} {
			if !strings.Contains(s, u) {
				t.Errorf("%s: missing %s", name, u)
			}
		}
	}
	if !strings.Contains(win, "os=windows&arch=amd64") {
		t.Error("windows download URL wrong")
	}
	if !strings.Contains(win, "--enroll $Token --server https://"+testHost+" --install") {
		t.Error("windows enroll command wrong")
	}
	if !strings.Contains(win, "exit $code") {
		t.Error("exit code not propagated")
	}
}

func TestRenderNoInsecureFlags(t *testing.T) {
	win, unix := render(t)
	for _, bad := range []string{"SkipCertificateCheck", "allow-insecure", "curl -k", "--insecure", "ServerCertificateValidationCallback"} {
		for name, s := range map[string]string{"windows": win, "unix": unix} {
			if strings.Contains(s, bad) {
				t.Errorf("%s contains %q", name, bad)
			}
		}
	}
	if regexp.MustCompile(`curl\s+(-\w*k\w*)\b`).MatchString(unix) {
		t.Error("unix curl with -k style flag")
	}
}

func TestRenderWindowsTokenIsParameterOnly(t *testing.T) {
	win, _ := render(t)
	if !strings.Contains(win, "param([Parameter(Mandatory)][string]$Token)") {
		t.Error("Token param not mandatory/plain")
	}
	if regexp.MustCompile(`\$Token\s*=`).MatchString(win) {
		t.Error("Token has a default or is assigned")
	}
}

func TestRenderWindowsTls12(t *testing.T) {
	win, _ := render(t)
	if !strings.Contains(win, "[Net.ServicePointManager]::SecurityProtocol") || !strings.Contains(win, "Tls12") {
		t.Error("TLS 1.2 not enabled")
	}
	for _, s := range []string{"$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'", "WindowsBuiltInRole]::Administrator"} {
		if !strings.Contains(win, s) {
			t.Errorf("missing %s", s)
		}
	}
}

func TestRenderWindowsSkipsImportWhenPresent(t *testing.T) {
	win, _ := render(t)
	if !strings.Contains(win, "Cert:\\LocalMachine\\Root\\$thumb") || !strings.Contains(win, "already trusted (e.g. via GPO)") {
		t.Error("thumbprint-present check missing")
	}
}

func TestRenderUnixPassesBashN(t *testing.T) {
	_, unix := render(t)
	p := filepath.Join(t.TempDir(), "b.sh")
	if err := os.WriteFile(p, []byte(unix), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("bash", "-n", p).CombinedOutput(); err != nil {
		t.Fatalf("bash -n: %v\n%s", err, out)
	}
	if !strings.Contains(unix, "update-ca-certificates") || !strings.Contains(unix, "update-ca-trust") || !strings.Contains(unix, "add-trusted-cert") {
		t.Error("trust branches missing")
	}
}

func TestRenderRejectsInvalidHost(t *testing.T) {
	for _, h := range []string{"", "a'; rm -rf /;'.example.com", "evil.com/x", "10.0.0.1", "host name.example.com", "x.example.com\"; calc", "single"} {
		dir := filepath.Join(t.TempDir(), "o")
		if _, _, err := Render(Params{Host: h, RootSHA256: testHash}, dir); err == nil {
			t.Errorf("host %q accepted", h)
		}
		if _, err := os.Stat(dir); err == nil {
			t.Errorf("host %q: output dir created", h)
		}
	}
}

func TestRenderRejectsBadHash(t *testing.T) {
	for _, h := range []string{"", "abc", strings.ToUpper(testHash), testHash + "0", testHash[:63] + "g", testHash[:63] + "'"} {
		if _, _, err := Render(Params{Host: testHost, RootSHA256: h}, t.TempDir()); err == nil {
			t.Errorf("hash %q accepted", h)
		}
	}
}

func TestRenderFileModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "o")
	w, u, err := Render(Params{Host: testHost, RootSHA256: testHash}, dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{w, u} {
		st, err := os.Stat(p)
		if err != nil || st.Mode().Perm() != 0o644 {
			t.Errorf("%s: %v %v", p, st, err)
		}
	}
}

// The scripts are written 0644, so the documented invocation must go through
// bash: `sudo ./bootstrap-unix.sh` would fail with "command not found".
func TestRenderUnixUsageRunsThroughBash(t *testing.T) {
	_, unix := render(t)
	if !strings.Contains(unix, "sudo bash bootstrap-unix.sh <enrollment-token>") {
		t.Error("usage does not say sudo bash bootstrap-unix.sh")
	}
	if strings.Contains(unix, "./bootstrap-unix.sh") {
		t.Error("usage still suggests ./bootstrap-unix.sh, which is not executable")
	}
}

// The service is registered at the path the agent runs from (os.Executable),
// so the scripts must install the binary at its permanent home first and run
// it from there. Found in the E2E run: bootstrap-unix.sh enrolled from its
// mktemp dir and then deleted it, so the systemd unit pointed at a deleted
// file and the agent failed with 203/EXEC on its first restart; the Windows
// script left the service pointing into %TEMP%.
func TestRenderInstallsAgentAtPermanentPath(t *testing.T) {
	win, unix := render(t)
	if !strings.Contains(win, `$exe = 'C:\F0\achilles-agent.exe'`) {
		t.Error(`windows: agent not installed at C:\F0\achilles-agent.exe`)
	}
	if !strings.Contains(win, "& $exe --enroll $Token") {
		t.Error("windows: enroll not run from the installed path")
	}
	if regexp.MustCompile(`Remove-Item[^\n]*\$exe\b`).MatchString(win) {
		t.Error("windows: deletes the installed agent binary")
	}
	if strings.Contains(win, "Join-Path $env:TEMP 'achilles-agent.exe'") {
		t.Error("windows: still runs the agent from the TEMP folder")
	}
	if !strings.Contains(unix, `AGENT=/opt/f0/achilles-agent`) {
		t.Error("unix: agent not installed at /opt/f0/achilles-agent")
	}
	if !strings.Contains(unix, `"$AGENT" --enroll "$TOKEN"`) {
		t.Error("unix: enroll not run from the installed path")
	}
	if strings.Contains(unix, `"$WORK/achilles-agent" --enroll`) {
		t.Error("unix: still enrolls from the temp dir that is deleted on exit")
	}
}

// A file downloaded to %TEMP% inherits an ACE for the user running the
// script; Move-Item turns it into an explicit ACE that the agent's
// `icacls /inheritance:r` cannot strip, leaving the SYSTEM service binary
// writable by that user's unelevated token (seen on Windows 11, PS 5.1).
// The script must replace the download's DACL before moving it into place.
func TestRenderWindowsLocksAgentACLBeforeMove(t *testing.T) {
	win, _ := render(t)
	for _, want := range []string{
		"$acl.SetAccessRuleProtection($true, $false)",
		"'S-1-5-18'",     // SYSTEM
		"'S-1-5-32-544'", // BUILTIN\Administrators
		"Set-Acl -LiteralPath $download -AclObject $acl",
	} {
		if !strings.Contains(win, want) {
			t.Errorf("windows: missing %q", want)
		}
	}
	setACL := strings.Index(win, "Set-Acl -LiteralPath $download")
	move := strings.Index(win, "Move-Item -Force -Path $download -Destination $exe")
	if move < 0 {
		t.Fatal("windows: Move-Item of the download not found")
	}
	if setACL < 0 || setACL > move {
		t.Error("windows: the download's ACL must be replaced before it is moved to C:\\F0")
	}
	if regexp.MustCompile(`(?i)S-1-5-11|Authenticated Users|Everyone|S-1-1-0|BUILTIN\\\\Users`).MatchString(win) {
		t.Error("windows: agent ACL grants a non-admin principal")
	}
}

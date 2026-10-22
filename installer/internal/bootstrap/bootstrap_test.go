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

// windowsOrder fails the test unless every marker occurs in the rendered
// script, in the given order (first occurrence of each).
func windowsOrder(t *testing.T, win string, markers ...string) {
	t.Helper()
	last, prev := -1, ""
	for _, m := range markers {
		i := strings.Index(win, m)
		if i < 0 {
			t.Errorf("windows: missing %q", m)
			continue
		}
		if i < last {
			t.Errorf("windows: %q must come after %q", m, prev)
		}
		last, prev = i, m
	}
}

// Threat model: the installing admin's UNELEVATED (UAC-filtered) token must
// not get a binary of its choosing run as SYSTEM, nor a root of its choosing
// trusted. %TEMP% is writable by that token, so nothing may be staged there:
// a file in it can be swapped between download and use (and after an ACL
// lock, since the user owns the parent folder). Earlier versions downloaded
// both the root and the agent there.
func TestRenderWindowsNeverStagesInTemp(t *testing.T) {
	win, _ := render(t)
	for _, bad := range []string{"$env:TEMP", "$env:TMP", "GetTempPath", "GetTempFileName", "certutil", "Get-FileHash"} {
		if strings.Contains(win, bad) {
			t.Errorf("windows: contains %q", bad)
		}
	}
	// The only file the script downloads is the agent, into C:\F0.
	outFiles := regexp.MustCompile(`-OutFile\s+(\S+)`).FindAllStringSubmatch(win, -1)
	if len(outFiles) != 1 || outFiles[0][1] != "$download" {
		t.Errorf("windows: -OutFile targets %v, want exactly [$download]", outFiles)
	}
	if !strings.Contains(win, `$download = 'C:\F0\achilles-agent.download'`) {
		t.Error(`windows: agent download target is not C:\F0\achilles-agent.download`)
	}
}

// C:\F0 under C:\ inherits Authenticated Users:Modify (delete-child), so the
// locked agent binary could be deleted and replaced. The directory must be
// locked (protected DACL, SYSTEM + Administrators by SID, owner
// Administrators) before anything is downloaded, and verified afterwards.
func TestRenderWindowsLocksF0BeforeAnyDownload(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		`$dir = 'C:\F0'`,
		"$systemSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'",
		"$adminsSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'",
		"$dirAcl = New-Object System.Security.AccessControl.DirectorySecurity",
		"$dirAcl.SetOwner($adminsSid)",
		"$dirAcl.SetAccessRuleProtection($true, $false)",
		"FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')",
		"[System.IO.Directory]::CreateDirectory($dir, $dirAcl)",
		"if (Test-ReparsePoint $dir) { throw",
		"Set-Acl -LiteralPath $dir -AclObject $dirAcl",
		"$dirOwner -ne 'S-1-5-32-544'",
		"-not $dirNow.AreAccessRulesProtected",
		"$foreign.Count -ne 0",
		"Invoke-WebRequest", // the first download comes only after the lock
	)
}

// The agent is downloaded into the locked C:\F0, given an explicit owner and
// protected DACL, renamed into place in the same directory, and only then
// run (enrolled + installed as the SYSTEM service).
func TestRenderWindowsLocksAgentBeforeRenameAndEnroll(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		"Set-Acl -LiteralPath $dir -AclObject $dirAcl",
		"if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }",
		"-OutFile $download",
		"$acl = New-Object System.Security.AccessControl.FileSecurity",
		"$acl.SetOwner($adminsSid)",
		"$acl.SetAccessRuleProtection($true, $false)",
		"Set-Acl -LiteralPath $download -AclObject $acl",
		"Move-Item -Force -LiteralPath $download -Destination $exe",
		"& $exe --enroll $Token",
	)
	if n := strings.Count(win, "& $exe"); n != 1 {
		t.Errorf("windows: the agent is run %d times, want once (after the lock)", n)
	}
}

// The root's bytes are hashed in memory and the SAME bytes are imported:
// certutil -addstore re-read a path in %TEMP% after it was hashed.
func TestRenderWindowsImportsVerifiedRootBytes(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		`$rootBytes = (Invoke-WebRequest -UseBasicParsing -Uri "http://`+testHost+`/ca/root.cer").RawContentStream.ToArray()`,
		"$actual = -join ($sha256.ComputeHash($rootBytes)",
		"if ($actual -ne $PinnedRootSha256.ToLowerInvariant()) {",
		"Aborting; nothing was trusted.",
		"X509Certificate2 -ArgumentList (,$rootBytes)",
		`if (Test-Path "Cert:\LocalMachine\Root\$thumb") {`,
		"[System.Security.Cryptography.X509Certificates.StoreName]::Root, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine",
		"$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)",
		"$store.Add($root)",
		"$store.Close()",
		"-OutFile $download", // the agent download comes after the root is trusted
	)
	if strings.Count(win, "$rootBytes = ") != 1 {
		t.Error("windows: $rootBytes assigned more than once")
	}
}

// Only SYSTEM and Administrators are ever granted anything, and only by SID.
var nonAdminPrincipal = regexp.MustCompile(`(?i)S-1-5-11\b|S-1-5-32-545\b|S-1-1-0\b|Authenticated Users|Everyone|BUILTIN\\Users|CREATOR OWNER|S-1-3-0\b`)

func TestRenderWindowsGrantsOnlySystemAndAdministrators(t *testing.T) {
	// The pattern must actually match what it guards against.
	for _, s := range []string{`BUILTIN\Users`, "Authenticated Users", "S-1-5-11", "S-1-1-0", "Everyone", "S-1-5-32-545"} {
		if !nonAdminPrincipal.MatchString(s) {
			t.Fatalf("nonAdminPrincipal does not match %q", s)
		}
	}
	win, _ := render(t)
	if m := nonAdminPrincipal.FindString(win); m != "" {
		t.Errorf("windows: names a non-admin principal %q", m)
	}
	for _, sid := range regexp.MustCompile(`S-1-[0-9-]+`).FindAllString(win, -1) {
		if sid != "S-1-5-18" && sid != "S-1-5-32-544" {
			t.Errorf("windows: unexpected SID %s", sid)
		}
	}
	if regexp.MustCompile(`NT AUTHORITY|BUILTIN\\Administrators|'Administrators'|'SYSTEM'`).MatchString(win) {
		t.Error("windows: uses a localized account name instead of a SID")
	}
	if n := strings.Count(win, "AddAccessRule("); n != 2 {
		t.Errorf("windows: %d AddAccessRule calls, want 2 (directory + agent, each looped over the two SIDs)", n)
	}
}

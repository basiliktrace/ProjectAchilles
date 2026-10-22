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

// psCode returns the script without its comments (the <# #> header and
// whole-line # comments), for checks that must not trip over prose.
func psCode(win string) string {
	var b strings.Builder
	inHeader := false
	for _, line := range strings.Split(win, "\n") {
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "<#"):
			inHeader = true
		case inHeader:
			inHeader = !strings.HasPrefix(t, "#>")
		case strings.HasPrefix(t, "#"):
		default:
			b.WriteString(line)
			b.WriteString("\n")
		}
	}
	return b.String()
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
	// The only file the script writes is the agent, into C:\F0, through a
	// FileStream it creates itself (no -OutFile, which creates the file with
	// the default owner and DACL).
	if strings.Contains(win, "-OutFile") {
		t.Error("windows: downloads with -OutFile")
	}
	if n := strings.Count(win, "New-Object System.IO.FileStream"); n != 1 {
		t.Errorf("windows: %d FileStreams, want 1 (the agent download)", n)
	}
	if !strings.Contains(win, "New-Object System.IO.FileStream -ArgumentList $download, ") {
		t.Error("windows: the FileStream does not write $download")
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

// Locking C:\F0's DACL reaches only children that inherit: a pre-existing
// child keeps its own owner and a protected DACL, and a junction leads
// outside. The agent runs test binaries as SYSTEM from C:\F0\tasks, so after
// the lock and before any download the script must walk everything under
// C:\F0 without following reparse points (aborting on any), reset each
// item's owner to Administrators and its DACL to inherited-only, and verify.
func TestRenderWindowsNormalizesF0BeforeAnyDownload(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		"function Invoke-F0Walk(",
		"Set-Acl -LiteralPath $dir -AclObject $dirAcl",
		"$foreign.Count -ne 0",
		// normalize pass
		"Invoke-F0Walk $dir {",
		"& $icacls $p /setowner '*S-1-5-32-544' /L /Q",
		"& $takeown /F $p /A",
		"& $icacls $p /reset /L /Q",
		// verify pass
		"$a = Get-Acl -LiteralPath $item.FullName",
		"$owner -ne 'S-1-5-32-544' -or $a.AreAccessRulesProtected -or $explicit.Count -ne 0 -or $others.Count -ne 0",
		"Invoke-WebRequest", // the first download comes only after both passes
	)
	if n := strings.Count(win, "Invoke-F0Walk $dir {"); n != 2 {
		t.Errorf("windows: %d walks of $dir, want 2 (normalize, verify)", n)
	}
	if !strings.Contains(win, "$explicit = @($a.GetAccessRules($true, $false, ") {
		t.Error("windows: verify pass does not look for explicit ACEs")
	}
	if !strings.Contains(win, "$icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'") ||
		!strings.Contains(win, "$takeown = Join-Path ([Environment]::SystemDirectory) 'takeown.exe'") {
		t.Error("windows: icacls/takeown not run from the system directory")
	}
	// Every throw in the passes stops the script before the download.
	for _, m := range []string{"(icacls exit code $LASTEXITCODE). Aborting; nothing was downloaded.", "(takeown exit code $LASTEXITCODE). Aborting; nothing was downloaded."} {
		if !strings.Contains(win, m) {
			t.Errorf("windows: missing abort %q", m)
		}
	}
}

// The walk is an explicit stack over one directory level at a time that
// checks ReparsePoint on every item and never descends into one; nothing in
// the script may recurse by itself (Get-ChildItem -Recurse follows junctions
// on PS 5.1, icacls /T walks the tree, icacls without /L acts on a link's
// target).
func TestRenderWindowsWalkNeverFollowsReparsePoints(t *testing.T) {
	win, _ := render(t)
	start := strings.Index(win, "function Invoke-F0Walk(")
	if start < 0 {
		t.Fatal("windows: no Invoke-F0Walk function")
	}
	walk := win[start:]
	walk = walk[:strings.Index(walk, "\n}\n")+2]
	windowsOrder(t, walk,
		"$stack = New-Object System.Collections.Stack",
		"while ($stack.Count -gt 0) {",
		"$parent = $stack.Pop()",
		"foreach ($item in $parent.GetFileSystemInfos()) {",
		"if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {",
		"is a junction, symbolic link or other reparse point.",
		"& $OnItem $item",
		"if ($item -is [System.IO.DirectoryInfo]) { $stack.Push($item) }",
	)
	code := psCode(win)
	for _, bad := range []string{"Get-ChildItem", "-Recurse", "EnumerateFileSystemInfos", "SearchOption", "Remove-Item -Recurse"} {
		if strings.Contains(code, bad) {
			t.Errorf("windows: contains %q", bad)
		}
	}
	icaclsCalls := regexp.MustCompile(`& \$icacls [^\n]*`).FindAllString(win, -1)
	if len(icaclsCalls) != 2 {
		t.Errorf("windows: %d icacls calls, want 2 (setowner, reset)", len(icaclsCalls))
	}
	for _, c := range icaclsCalls {
		if !strings.Contains(c, " /L ") || regexp.MustCompile(`(?i)\s/T\b`).MatchString(c) {
			t.Errorf("windows: icacls call %q must use /L and never /T", c)
		}
	}
	if regexp.MustCompile(`(?i)takeown[^\n]*\s/R\b`).MatchString(win) {
		t.Error("windows: takeown recurses")
	}
}

// The agent is downloaded into the locked C:\F0, given an explicit owner and
// protected DACL, renamed into place in the same directory, and only then
// run (enrolled + installed as the SYSTEM service).
func TestRenderWindowsLocksAgentBeforeRenameAndEnroll(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		"Set-Acl -LiteralPath $dir -AclObject $dirAcl",
		"if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }",
		"$agentResp = Invoke-WebRequest -UseBasicParsing -Uri \"https://"+testHost+"/api/agent/download?os=windows&arch=amd64\"",
		"$acl = New-Object System.Security.AccessControl.FileSecurity",
		"$acl.SetOwner($adminsSid)",
		"$acl.SetAccessRuleProtection($true, $false)",
		// created with that descriptor, never over an existing file
		"New-Object System.IO.FileStream -ArgumentList $download, ([System.IO.FileMode]::CreateNew), ([System.Security.AccessControl.FileSystemRights]::Write), ([System.IO.FileShare]::None), 65536, ([System.IO.FileOptions]::None), $acl",
		"$agentResp.RawContentStream.WriteTo($fs)",
		"$fs.Close()",
		"$dlAcl = Get-Acl -LiteralPath $download",
		"was not created with owner Administrators and a SYSTEM + Administrators DACL; aborting.",
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
		"$agentResp = Invoke-WebRequest", // the agent download comes after the root is trusted
	)
	if strings.Count(win, "$rootBytes = ") != 1 {
		t.Error("windows: $rootBytes assigned more than once")
	}
}

// Only SYSTEM and Administrators are ever granted anything beyond
// ReadPermissions, and only by SID. OWNER RIGHTS (S-1-3-4) gets exactly
// ReadPermissions on C:\F0, inherited, so that whoever owns an item there
// has no implicit WRITE_DAC.
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
		if sid != "S-1-5-18" && sid != "S-1-5-32-544" && sid != "S-1-3-4" {
			t.Errorf("windows: unexpected SID %s", sid)
		}
	}
	if regexp.MustCompile(`NT AUTHORITY|BUILTIN\\Administrators|'Administrators'|'SYSTEM'`).MatchString(win) {
		t.Error("windows: uses a localized account name instead of a SID")
	}
	if n := strings.Count(win, "AddAccessRule("); n != 3 {
		t.Errorf("windows: %d AddAccessRule calls, want 3 (directory and agent, each looped over the two SIDs, plus OWNER RIGHTS)", n)
	}
	// Every rule grants FullControl to $sid (SYSTEM/Administrators) or
	// ReadPermissions to OWNER RIGHTS, nothing else.
	for _, r := range regexp.MustCompile(`FileSystemAccessRule\(([^,]+), '([^']+)'`).FindAllStringSubmatch(win, -1) {
		if !(r[1] == "$sid" && r[2] == "FullControl") && !(r[1] == "$ownerRightsSid" && r[2] == "ReadPermissions") {
			t.Errorf("windows: unexpected access rule %s %s", r[1], r[2])
		}
	}
}

// Under the "object creator" owner policy an elevated admin's new file is
// owned by the admin's user SID, whose unelevated token would then hold the
// owner's implicit WRITE_DAC. An inheritable OWNER RIGHTS ACE on C:\F0 caps
// the owner at ReadPermissions, and the directory verification accepts it.
func TestRenderWindowsOwnerRightsAce(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		"$ownerRightsSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-3-4'",
		"$lockSids = 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4'",
		"$dirAcl.SetAccessRuleProtection($true, $false)",
		"$dirAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($ownerRightsSid, 'ReadPermissions', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))",
		"Set-Acl -LiteralPath $dir -AclObject $dirAcl",
		"$foreign = @($dirNow.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $lockSids -notcontains $_.IdentityReference.Value })",
	)
	if n := strings.Count(win, "$ownerRightsSid,"); n != 1 {
		t.Errorf("windows: OWNER RIGHTS granted %d times, want once (C:\\F0, inherited)", n)
	}
}

// Found on Windows (PS 5.1): re-running the script over a running agent
// failed in Move-Item with "Cannot create a file when that file already
// exists" and left the service stopped. The SCM reports AchillesAgent
// Stopped a few milliseconds before its process has exited and released its
// image, so the replace raced the exit. The script must wait for the
// service's own process by PID (an exiting process no longer reports a Path,
// so a Path filter misses exactly that window), and refuse to replace the
// binary while it still runs.
func TestRenderWindowsWaitsForAgentExitBeforeReplace(t *testing.T) {
	win, _ := render(t)
	windowsOrder(t, win,
		`$svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='AchillesAgent'"`,
		"$svcPid = [int]$svc.ProcessId",
		"$svcProc = Get-Process -Id $svcPid",
		"Stop-Service -Name AchillesAgent -Force -ErrorAction Stop",
		"$svcProc | Wait-Process -Timeout 60 -ErrorAction Stop",
		"The AchillesAgent service did not stop within 60 s",
		"Nothing was changed: the installed agent binary was not replaced",
		"Get-Process -Name achilles-agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }",
		"is still running after stopping AchillesAgent; aborting.",
		"Move-Item -Force -LiteralPath $download -Destination $exe",
	)
	if strings.Contains(win, "$running | Wait-Process") {
		t.Error("windows: waits on a Path-filtered process list, which misses an exiting process")
	}
	// A failed stop or wait must not be swallowed: it used to surface only as
	// a misleading Move-Item error, with the agent left stopped.
	for _, line := range strings.Split(psCode(win), "\n") {
		if (strings.Contains(line, "Stop-Service") || strings.Contains(line, "Wait-Process")) && !strings.Contains(line, "-ErrorAction Stop") {
			t.Errorf("windows: %q lacks -ErrorAction Stop", strings.TrimSpace(line))
		}
	}
}

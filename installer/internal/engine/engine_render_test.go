// Engine tests: run the real scripts/deploy-server.sh in a temp copy of the
// repo and check what it writes and the progress lines it prints.
//
//	cd installer && go test -count=1 ./internal/engine/
//
// Keep -count=1 when you change the script: it lives outside this Go module,
// so the test cache does not notice edits to it.
//
// Most tests run with ACHILLES_RENDER_ONLY=1. The full-run tests replace
// docker, sudo and systemctl with stubs on PATH, so nothing touches the host.
package engine

import (
	"bufio"
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// installerBin is the achilles-installer binary built once by TestMain.
var installerBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "engine-test-bin-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	installerBin = filepath.Join(dir, "achilles-installer")
	build := exec.Command("go", "build", "-o", installerBin, ".")
	build.Dir = filepath.Join("..", "..") // the installer module root
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "go build achilles-installer: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func testdata(t *testing.T, parts ...string) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join(append([]string{"testdata"}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func writeFile(t *testing.T, path, data string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), mode); err != nil {
		t.Fatal(err)
	}
}

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, fi.Mode().Perm())
	})
	if err != nil {
		t.Fatalf("copy %s: %v", src, err)
	}
}

// sandbox is a temp copy of the parts of the repo the engine reads and writes.
type sandbox struct {
	root    string // the fake REPO_ROOT
	caDir   string // ACHILLES_CA_DIR_OVERRIDE
	stubs   string // first on PATH
	stubLog string // every stubbed command appends a line here
	cfg     string
	env     map[string]string
}

// newSandbox copies the engine's inputs and writes the config: the mode's
// file, then common.env (unless omitCommon), then extra.
func newSandbox(t *testing.T, mode, extra string) *sandbox {
	t.Helper()
	repo := repoRoot(t)
	root := t.TempDir()
	s := &sandbox{
		root:    root,
		caDir:   filepath.Join(root, "ca-dir"),
		stubs:   filepath.Join(root, "stubs"),
		stubLog: filepath.Join(root, "stub.log"),
		cfg:     filepath.Join(root, "deploy.config.env"),
	}
	for _, f := range []string{"deploy-server.sh", "ca-renew.sh"} {
		b, err := os.ReadFile(filepath.Join(repo, "scripts", f))
		if errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(root, "scripts", f), string(b), 0o755)
	}
	copyTree(t, filepath.Join(repo, "deploy", "caddy"), filepath.Join(root, "deploy", "caddy"))
	writeFile(t, filepath.Join(root, "docker-compose.server.yml"), readFile(t, filepath.Join(repo, "docker-compose.server.yml")), 0o644)
	if err := os.MkdirAll(filepath.Join(root, "backend"), 0o755); err != nil {
		t.Fatal(err)
	}
	copyTree(t, testdata(t, "stubs"), s.stubs)
	if mode == "byo" {
		writeFile(t, filepath.Join(root, "deploy", "caddy", "certs", "cert.pem"), "placeholder\n", 0o644)
		writeFile(t, filepath.Join(root, "deploy", "caddy", "certs", "key.pem"), "placeholder\n", 0o644)
	}
	cfg := readFile(t, testdata(t, "configs", mode+".env")) + readFile(t, testdata(t, "configs", "common.env")) + extra
	writeFile(t, s.cfg, cfg, 0o600)
	s.env = map[string]string{
		"PATH":                     s.stubs + ":/usr/bin:/bin",
		"HOME":                     root,
		"STUB_LOG":                 s.stubLog,
		"ACHILLES_RENDER_ONLY":     "1",
		"ACHILLES_NONINTERACTIVE":  "1",
		"ACHILLES_INSTALLER_BIN":   installerBin,
		"ACHILLES_CA_DIR_OVERRIDE": s.caDir,
	}
	return s
}

// setConfig rewrites the config file.
func (s *sandbox) setConfig(t *testing.T, cfg string) { writeFile(t, s.cfg, cfg, 0o600) }

func (s *sandbox) path(parts ...string) string {
	return filepath.Join(append([]string{s.root}, parts...)...)
}

type result struct {
	stdout, stderr string
	code           int
}

func (r result) String() string {
	return fmt.Sprintf("exit %d\n--- stdout ---\n%s\n--- stderr ---\n%s", r.code, r.stdout, r.stderr)
}

// run executes the engine with a clean environment (no host secrets leak in):
// only s.env, with overrides applied ("" deletes a variable).
func (s *sandbox) run(t *testing.T, overrides map[string]string, args ...string) result {
	t.Helper()
	return s.exec(t, overrides, append([]string{"bash", s.path("scripts", "deploy-server.sh")}, args...))
}

func (s *sandbox) exec(t *testing.T, overrides map[string]string, argv []string) result {
	t.Helper()
	env := map[string]string{}
	for k, v := range s.env {
		env[k] = v
	}
	for k, v := range overrides {
		if v == "" {
			delete(env, k)
		} else {
			env[k] = v
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = s.root
	cmd.Env = []string{}
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("engine timed out\n%s\n%s", out.String(), errb.String())
	}
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return result{out.String(), errb.String(), code}
}

func (s *sandbox) mustRun(t *testing.T, overrides map[string]string, args ...string) result {
	t.Helper()
	r := s.run(t, overrides, append([]string{s.cfg}, args...)...)
	if r.code != 0 {
		t.Fatalf("engine failed\n%s", r)
	}
	return r
}

// stripGenerated drops the timestamp comment, the only line that changes
// between runs.
func stripGenerated(s string) string {
	var b strings.Builder
	for _, l := range strings.SplitAfter(s, "\n") {
		if strings.HasPrefix(l, "# Generated by deploy-server.sh") {
			continue
		}
		b.WriteString(l)
	}
	return b.String()
}

// envValue returns KEY's value from a KEY=VALUE file and whether it is set.
func envValue(content, key string) (string, bool) {
	for _, l := range strings.Split(content, "\n") {
		if v, ok := strings.CutPrefix(l, key+"="); ok {
			return v, true
		}
	}
	return "", false
}

var eventRe = regexp.MustCompile(`^::(phase|ok|warn|fail)(?: (.*))?$`)
var idRe = regexp.MustCompile(`^[a-z0-9-]+$`)
var ansiRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

type event struct{ kind, id, text string }

// events parses the progress protocol lines in stdout.
func events(t *testing.T, stdout string) []event {
	t.Helper()
	var evs []event
	sc := bufio.NewScanner(strings.NewReader(stdout))
	for sc.Scan() {
		l := sc.Text()
		if !strings.HasPrefix(l, "::") {
			continue
		}
		m := eventRe.FindStringSubmatch(l)
		if m == nil {
			t.Fatalf("malformed progress line %q", l)
		}
		e := event{kind: m[1]}
		switch e.kind {
		case "warn":
			e.text = m[2]
		default:
			e.id, e.text, _ = strings.Cut(m[2], " ")
			if !idRe.MatchString(e.id) {
				t.Fatalf("bad phase id in %q", l)
			}
		}
		evs = append(evs, e)
	}
	return evs
}

// phaseIDs checks every phase closes with its ok before the next one opens and
// returns the phase ids in order. It fails the test on any ::fail.
func phaseIDs(t *testing.T, r result) []string {
	t.Helper()
	var ids []string
	open := ""
	for _, e := range events(t, r.stdout) {
		switch e.kind {
		case "phase":
			if open != "" {
				t.Fatalf("phase %q opened before %q was ok\n%s", e.id, open, r)
			}
			if e.text == "" {
				t.Fatalf("phase %q has no title", e.id)
			}
			open = e.id
			ids = append(ids, e.id)
		case "ok":
			if e.id != open {
				t.Fatalf("::ok %s while phase %q is open\n%s", e.id, open, r)
			}
			open = ""
		case "fail":
			t.Fatalf("unexpected ::fail %s %s\n%s", e.id, e.text, r)
		}
	}
	if open != "" {
		t.Fatalf("phase %q never reported ok\n%s", open, r)
	}
	return ids
}

func failEvent(t *testing.T, r result) (event, bool) {
	t.Helper()
	for _, e := range events(t, r.stdout) {
		if e.kind == "fail" {
			return e, true
		}
	}
	return event{}, false
}

func rootCert(t *testing.T, caDir string) *x509.Certificate {
	t.Helper()
	blk, _ := pem.Decode([]byte(readFile(t, filepath.Join(caDir, "root.crt"))))
	if blk == nil {
		t.Fatal("root.crt is not PEM")
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// ---------------------------------------------------------------------------
// Backward compatibility: existing modes render what main rendered.
// ---------------------------------------------------------------------------

// assertMatchesGolden checks the env files against main's output. The one
// intended difference in the root .env is an appended, EMPTY CADDY_BIND_IP:
// empty means compose publishes Caddy on all IPv4 and IPv6 addresses exactly
// as main did (0.0.0.0 would drop the [::] listeners). ACHILLES_CA_DIR is
// written only in achilles-ca mode, so it must be absent here.
func assertMatchesGolden(t *testing.T, mode string) {
	t.Helper()
	s := newSandbox(t, mode, "")
	s.mustRun(t, nil)

	wantBackend := readFile(t, testdata(t, "golden", mode+".backend.env"))
	if got := stripGenerated(readFile(t, s.path("backend", ".env"))); got != wantBackend {
		t.Errorf("backend/.env differs from main's\n--- got ---\n%s--- want ---\n%s", got, wantBackend)
	}
	wantRoot := readFile(t, testdata(t, "golden", mode+".root.env")) + "CADDY_BIND_IP=\nCOMPOSE_PROJECT_NAME=achilles-server\n"
	if got := stripGenerated(readFile(t, s.path(".env"))); got != wantRoot {
		t.Errorf(".env differs from main's + CADDY_BIND_IP= + COMPOSE_PROJECT_NAME\n--- got ---\n%s--- want ---\n%s", got, wantRoot)
	}

	repo := repoRoot(t)
	rendered := map[string]string{
		"tls.caddy":         filepath.Join("tls-modes", mode+".caddy"),
		"global.caddy":      "global.caddy",
		"sites-extra.caddy": "sites-extra.caddy",
	}
	for out, src := range rendered {
		want := readFile(t, filepath.Join(repo, "deploy", "caddy", src))
		if got := readFile(t, s.path("deploy", "caddy", "rendered", out)); got != want {
			t.Errorf("rendered/%s != deploy/caddy/%s", out, src)
		}
	}
	// The committed reference copy is no longer written (it would dirty the tree).
	if got, want := readFile(t, s.path("deploy", "caddy", "tls.caddy")), readFile(t, filepath.Join(repo, "deploy", "caddy", "tls.caddy")); got != want {
		t.Errorf("deploy/caddy/tls.caddy was modified")
	}
	if _, err := os.Stat(s.path("deploy", "onprem")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("deploy/onprem should not exist outside achilles-ca (err=%v)", err)
	}
	if _, err := os.Stat(s.caDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("CA dir should not exist outside achilles-ca (err=%v)", err)
	}
	if b, err := os.ReadFile(s.stubLog); err == nil && len(b) > 0 {
		t.Errorf("render-only ran docker:\n%s", b)
	}
	for _, f := range []string{".env", filepath.Join("backend", ".env")} {
		fi, err := os.Stat(s.path(f))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", f, fi.Mode().Perm())
		}
	}
}

func TestEngineAcmeHTTPRenderMatchesGolden(t *testing.T) { assertMatchesGolden(t, "acme-http") }

func TestEngineExistingModesRenderMatchGolden(t *testing.T) {
	for _, mode := range []string{"acme-dns", "internal", "byo"} {
		t.Run(mode, func(t *testing.T) { assertMatchesGolden(t, mode) })
	}
}

// ---------------------------------------------------------------------------
// achilles-ca
// ---------------------------------------------------------------------------

func TestEngineAchillesCARender(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	r := s.mustRun(t, map[string]string{"ACHILLES_PROGRESS": "1"})

	root := readFile(t, s.path(".env"))
	if v, _ := envValue(root, "CADDY_BIND_IP"); v != "10.0.5.20" {
		t.Errorf("CADDY_BIND_IP = %q, want 10.0.5.20", v)
	}
	if v, _ := envValue(root, "ACHILLES_CA_DIR"); v != s.caDir {
		t.Errorf("ACHILLES_CA_DIR = %q, want %q", v, s.caDir)
	}
	if v, _ := envValue(root, "ACME_EMAIL"); v != "" {
		t.Errorf("ACME_EMAIL = %q, want empty", v)
	}
	if v, _ := envValue(readFile(t, s.path("backend", ".env")), "AGENT_SERVER_URL"); v != "https://achilles.corp.example.com" {
		t.Errorf("AGENT_SERVER_URL = %q", v)
	}

	repo := repoRoot(t)
	for out, src := range map[string]string{
		"tls.caddy":         "tls-modes/achilles-ca.caddy",
		"global.caddy":      "extras/achilles-ca.global.caddy",
		"sites-extra.caddy": "extras/achilles-ca.sites.caddy",
	} {
		if got, want := readFile(t, s.path("deploy", "caddy", "rendered", out)), readFile(t, filepath.Join(repo, "deploy", "caddy", src)); got != want {
			t.Errorf("rendered/%s != deploy/caddy/%s", out, src)
		}
	}
	if !strings.Contains(readFile(t, s.path("deploy", "caddy", "rendered", "global.caddy")), "pki") {
		t.Error("rendered/global.caddy has no pki block")
	}

	for _, f := range []string{"root.crt", "root.key", "caddy/root.crt", "caddy/intermediate.crt", "caddy/intermediate.key", "public/root.crt", "public/root.cer"} {
		if _, err := os.Stat(filepath.Join(s.caDir, f)); err != nil {
			t.Errorf("CA file %s: %v", f, err)
		}
	}
	c := rootCert(t, s.caDir)
	if got := c.PermittedDNSDomains; len(got) != 1 || got[0] != "corp.example.com" {
		t.Errorf("root permitted DNS = %v, want [corp.example.com]", got)
	}
	if got := c.PermittedIPRanges; len(got) != 1 || got[0].String() != "10.0.5.20/32" {
		t.Errorf("root permitted IPs = %v, want [10.0.5.20/32] (CA_INCLUDE_IP=true)", got)
	}
	if !strings.Contains(c.Subject.CommonName, "Corp Example") {
		t.Errorf("root CN %q does not carry ORGANIZATION_NAME", c.Subject.CommonName)
	}

	for _, f := range []string{"bootstrap-windows.ps1", "bootstrap-unix.sh"} {
		b := readFile(t, s.path("deploy", "onprem", f))
		if !strings.Contains(b, "achilles.corp.example.com") {
			t.Errorf("%s does not pin the host", f)
		}
	}
	if b, err := os.ReadFile(s.stubLog); err == nil && len(b) > 0 {
		t.Errorf("render-only ran docker:\n%s", b)
	}

	want := []string{"config", "validate", "ca", "caddy-render", "backend-env", "root-env", "bootstrap"}
	if got := phaseIDs(t, r); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("phases = %v, want %v", got, want)
	}
}

func TestEngineAchillesCAExcludesIPWhenNotIncluded(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "CA_INCLUDE_IP=false\n")
	s.mustRun(t, nil)
	c := rootCert(t, s.caDir)
	if len(c.PermittedIPRanges) != 0 || len(c.ExcludedIPRanges) != 2 {
		t.Errorf("permitted=%v excluded=%v, want none permitted and all IPs excluded", c.PermittedIPRanges, c.ExcludedIPRanges)
	}
}

// An IPv6 LAN IP is bracketed for compose and passed bare to ca init.
func TestEngineAchillesCAIPv6BindIP(t *testing.T) {
	for _, in := range []string{"fd00::1", "[fd00::1]"} {
		t.Run(in, func(t *testing.T) {
			s := newSandbox(t, "achilles-ca", "CADDY_BIND_IP="+in+"\n")
			s.mustRun(t, nil)
			if v, _ := envValue(readFile(t, s.path(".env")), "CADDY_BIND_IP"); v != "[fd00::1]" {
				t.Errorf("CADDY_BIND_IP = %q, want [fd00::1]", v)
			}
			_, want, _ := net.ParseCIDR("fd00::1/128")
			c := rootCert(t, s.caDir)
			if len(c.PermittedIPRanges) != 1 || c.PermittedIPRanges[0].String() != want.String() {
				t.Errorf("root permitted IPs = %v, want [%v]", c.PermittedIPRanges, want)
			}
		})
	}
}

func TestEngineAchillesCAMissingBinaryFails(t *testing.T) {
	cases := map[string]map[string]string{
		"not executable":                   {"ACHILLES_INSTALLER_BIN": "/nonexistent/achilles-installer"},
		"unset, no default binary in repo": {"ACHILLES_INSTALLER_BIN": ""},
	}
	for name, ov := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSandbox(t, "achilles-ca", "")
			ov["ACHILLES_PROGRESS"] = "1"
			r := s.run(t, ov, s.cfg)
			e, ok := failEvent(t, r)
			if r.code == 0 || !ok || e.id != "ca" || !strings.Contains(e.text, "achilles-installer") {
				t.Fatalf("want exit != 0 and ::fail ca …achilles-installer…\n%s", r)
			}
		})
	}
}

func TestEngineAchillesCAValidation(t *testing.T) {
	cases := map[string]string{
		"domain outside the CA zone": "ACHILLES_DOMAIN=achilles.other.example\n",
		"missing CA_ZONE":            "CA_ZONE=\n",
		"missing CADDY_BIND_IP":      "CADDY_BIND_IP=\n",
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSandbox(t, "achilles-ca", extra)
			r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.cfg)
			if e, ok := failEvent(t, r); r.code == 0 || !ok || e.id != "validate" {
				t.Fatalf("want exit != 0 and ::fail validate\n%s", r)
			}
			if _, err := os.Stat(s.caDir); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("CA created despite invalid config")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Compose project name
// ---------------------------------------------------------------------------

// The root .env pins the compose project so two checkouts in directories with
// the same name never share containers and volumes. Fresh installs get
// achilles-server; an install from before the setting keeps the directory
// name compose was already using.
func TestEngineComposeProjectName(t *testing.T) {
	legacyEnv := "# Generated by deploy-server.sh on 2026-01-01T00:00:00Z — do not commit.\nACHILLES_DOMAIN=old.example\n"
	cases := []struct {
		name, rootEnv, extra, want string
	}{
		{"fresh install", "", "", "achilles-server"},
		{"earlier deploy-server.sh install", legacyEnv, "", "<dir>"},
		{"already pinned", "COMPOSE_PROJECT_NAME=pa-lab\n", "", "pa-lab"},
		{"hand-written root .env", "FOO=bar\n", "", "achilles-server"},
		{"set in the config", "", "COMPOSE_PROJECT_NAME=pa-second\n", "pa-second"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newSandbox(t, "acme-http", c.extra)
			if c.rootEnv != "" {
				writeFile(t, s.path(".env"), c.rootEnv, 0o600)
			}
			s.mustRun(t, nil)
			want := c.want
			if want == "<dir>" {
				want = filepath.Base(s.root) // t.TempDir names are already compose-safe
			}
			if got, _ := envValue(readFile(t, s.path(".env")), "COMPOSE_PROJECT_NAME"); got != want {
				t.Errorf("COMPOSE_PROJECT_NAME = %q, want %q", got, want)
			}
		})
	}
}

func TestEngineComposeProjectNameValidation(t *testing.T) {
	cases := map[string]struct{ rootEnv, extra, msg string }{
		"invalid name":          {"", "COMPOSE_PROJECT_NAME=Bad.Name\n", "must be lowercase"},
		"renaming a pinned one": {"COMPOSE_PROJECT_NAME=achilles-server\n", "COMPOSE_PROJECT_NAME=other\n", "achilles-server_* volumes"},
		"renaming a legacy one": {"# Generated by deploy-server.sh on x\n", "COMPOSE_PROJECT_NAME=other\n", "_* volumes"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			s := newSandbox(t, "acme-http", c.extra)
			if c.rootEnv != "" {
				writeFile(t, s.path(".env"), c.rootEnv, 0o600)
			}
			r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.cfg)
			e, ok := failEvent(t, r)
			if r.code == 0 || !ok || e.id != "validate" || !strings.Contains(e.text, c.msg) {
				t.Fatalf("want ::fail validate mentioning %q\n%s", c.msg, r)
			}
			if c.rootEnv != "" {
				if got := readFile(t, s.path(".env")); got != c.rootEnv {
					t.Errorf("root .env rewritten despite the failure: %q", got)
				}
			}
		})
	}
}

// A full run refuses a compose project whose containers another checkout
// started: `up` would recreate them from this file and mount their volumes.
func TestEngineFullRunRefusesAnotherCheckoutsProject(t *testing.T) {
	s := newSandbox(t, "acme-http", "")
	addFullRunStubs(t, s)
	full := map[string]string{"ACHILLES_RENDER_ONLY": "", "ACHILLES_PROGRESS": "1", "STUB_DOCKER_PS": "/home/dev/ProjectAchilles"}
	r := s.run(t, full, s.cfg)
	e, ok := failEvent(t, r)
	if r.code == 0 || !ok || e.id != "docker" || !strings.Contains(e.text, "/home/dev/ProjectAchilles") {
		t.Fatalf("want ::fail docker naming the other checkout\n%s", r)
	}
	if calls := strings.Join(stubLines(t, s, "docker"), "\n"); strings.Contains(calls, " up ") {
		t.Errorf("ran compose up anyway:\n%s", calls)
	}

	// Its own containers (a re-run) are fine.
	full["STUB_DOCKER_PS"] = s.root
	s.mustRun(t, full)
}

// ---------------------------------------------------------------------------
// Progress protocol and non-interactive mode
// ---------------------------------------------------------------------------

func TestEngineProgressLines(t *testing.T) {
	s := newSandbox(t, "acme-http", "")
	r := s.mustRun(t, map[string]string{"ACHILLES_PROGRESS": "1"})
	idx := func(line string) int {
		for i, l := range strings.Split(r.stdout, "\n") {
			if l == line || strings.HasPrefix(l, line+" ") {
				return i
			}
		}
		return -1
	}
	p, o := idx("::phase validate"), idx("::ok validate")
	if p < 0 || o < 0 || o < p {
		t.Fatalf("want ::phase validate then ::ok validate\n%s", r)
	}
	if strings.Contains(r.stdout, "::fail") || strings.Contains(r.stderr, "::fail") {
		t.Fatalf("unexpected ::fail\n%s", r)
	}
	want := []string{"config", "validate", "caddy-render", "backend-env", "root-env"}
	if got := phaseIDs(t, r); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("phases = %v, want %v", got, want)
	}
	// The protocol line replaces the human phase line (no duplicates), other
	// human detail stays, and piped output has no colour codes.
	if n := strings.Count(r.stdout, "Validating settings"); n != 1 {
		t.Errorf("phase title appears %d times, want once (the ::phase line)\n%s", n, r)
	}
	if strings.Contains(r.stdout, "==> ") {
		t.Errorf("human phase line printed alongside ::phase\n%s", r)
	}
	if !strings.Contains(r.stdout, "  ✓ Settings validated") {
		t.Errorf("human detail missing\n%s", r)
	}
	if strings.ContainsRune(r.stdout+r.stderr, 0x1b) {
		t.Errorf("escape sequence in piped output\n%s", r)
	}
}

// Under ACHILLES_PROGRESS a failure is reported once, as ::fail.
func TestEngineProgressFailReportedOnce(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "CA_ZONE=\n")
	r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.cfg)
	if r.code == 0 {
		t.Fatalf("want a failure\n%s", r)
	}
	all := r.stdout + r.stderr
	if !strings.Contains(all, "::fail validate") || strings.Contains(ansiRe.ReplaceAllString(all, ""), "error:") {
		t.Fatalf("want only the ::fail line, no human error: line\n%s", r)
	}
}

func TestEngineNoProgressLinesByDefault(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	r := s.mustRun(t, nil)
	for _, l := range strings.Split(r.stdout+r.stderr, "\n") {
		if strings.HasPrefix(l, "::") {
			t.Fatalf("protocol line without ACHILLES_PROGRESS: %q", l)
		}
	}
	plain := ansiRe.ReplaceAllString(r.stdout, "")
	for _, want := range []string{"==> Loading configuration", "==> Validating settings", "  ✓ Settings validated"} {
		if !strings.Contains(plain, want) {
			t.Errorf("stdout lacks %q\n%s", want, r)
		}
	}
}

func configWithout(t *testing.T, mode, key string) string {
	t.Helper()
	var b strings.Builder
	for _, l := range strings.SplitAfter(readFile(t, testdata(t, "configs", mode+".env"))+readFile(t, testdata(t, "configs", "common.env")), "\n") {
		if strings.HasPrefix(l, key+"=") {
			continue
		}
		b.WriteString(l)
	}
	return b.String()
}

func TestEngineNonInteractiveMissingValueFails(t *testing.T) {
	s := newSandbox(t, "acme-http", "")
	s.setConfig(t, configWithout(t, "acme-http", "CLERK_SECRET_KEY"))
	r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.cfg)
	e, ok := failEvent(t, r)
	if r.code == 0 || !ok || e.id != "validate" || !strings.Contains(e.text, "CLERK_SECRET_KEY") {
		t.Fatalf("want exit != 0 and ::fail validate …CLERK_SECRET_KEY…\n%s", r)
	}
	if _, err := os.Stat(s.path("backend", ".env")); !errors.Is(err, os.ErrNotExist) {
		t.Error("backend/.env written despite the failure")
	}
}

// ACHILLES_NONINTERACTIVE=1 must refuse to prompt even when a TTY is present.
// util-linux `script` provides the pseudo-terminal.
func TestEngineNonInteractiveRefusesPromptWithTTY(t *testing.T) {
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("util-linux script not installed")
	}
	s := newSandbox(t, "acme-http", "")
	s.setConfig(t, configWithout(t, "acme-http", "CLERK_SECRET_KEY"))
	inner := "bash " + s.path("scripts", "deploy-server.sh") + " " + s.cfg
	r := s.exec(t, nil, []string{"/usr/bin/script", "-qec", inner, "/dev/null"})
	if r.code == 0 || !strings.Contains(r.stdout+r.stderr, "ACHILLES_NONINTERACTIVE") {
		t.Fatalf("want a non-interactive refusal naming ACHILLES_NONINTERACTIVE\n%s", r)
	}
}

func TestEngineDieOutsideConfigFileFails(t *testing.T) {
	s := newSandbox(t, "acme-http", "")
	r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.path("missing.env"))
	if e, ok := failEvent(t, r); r.code == 0 || !ok || e.id != "config" {
		t.Fatalf("want ::fail config for a missing config file\n%s", r)
	}
}

func TestEngineRenderOnlyFlag(t *testing.T) {
	s := newSandbox(t, "acme-http", "")
	// The flag alone selects render-only; with the env var unset and docker
	// stubbed, any docker call would show up in the stub log.
	r := s.run(t, map[string]string{"ACHILLES_RENDER_ONLY": ""}, "--render-only", s.cfg)
	if r.code != 0 {
		t.Fatalf("engine failed\n%s", r)
	}
	if b, err := os.ReadFile(s.stubLog); err == nil && len(b) > 0 {
		t.Errorf("--render-only ran docker:\n%s", b)
	}
	if _, err := os.Stat(s.path(".env")); err != nil {
		t.Error(".env not written")
	}
}

func TestEngineRerunIdempotent(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	s.mustRun(t, nil)
	files := []string{
		".env", "backend/.env",
		"deploy/caddy/rendered/tls.caddy", "deploy/caddy/rendered/global.caddy", "deploy/caddy/rendered/sites-extra.caddy",
		"deploy/onprem/bootstrap-windows.ps1", "deploy/onprem/bootstrap-unix.sh",
	}
	snap := func() map[string]string {
		m := map[string]string{}
		for _, f := range files {
			m[f] = stripGenerated(readFile(t, s.path(f)))
		}
		m["ca/caddy/intermediate.crt"] = readFile(t, filepath.Join(s.caDir, "caddy", "intermediate.crt"))
		m["ca/public/root.cer"] = readFile(t, filepath.Join(s.caDir, "public", "root.cer"))
		return m
	}
	first, serial := snap(), rootCert(t, s.caDir).SerialNumber
	s.mustRun(t, nil)
	if got := rootCert(t, s.caDir).SerialNumber; got.Cmp(serial) != 0 {
		t.Errorf("root serial changed on re-run: %v -> %v", serial, got)
	}
	for f, want := range first {
		if got := snap()[f]; got != want {
			t.Errorf("%s changed on re-run", f)
		}
	}
}

// ---------------------------------------------------------------------------
// Full runs (docker, sudo and systemctl stubbed)
// ---------------------------------------------------------------------------

// addFullRunStubs adds sudo (runs its arguments), an install that logs and
// drops -o/-g (chown needs real root) before running the real install, and a
// systemctl that logs and remembers whether the timer was enabled.
func addFullRunStubs(t *testing.T, s *sandbox) string {
	t.Helper()
	writeFile(t, filepath.Join(s.stubs, "sudo"), "#!/bin/sh\nexec \"$@\"\n", 0o755)
	writeFile(t, filepath.Join(s.stubs, "install"), `#!/bin/sh
echo "install $*" >> "$STUB_LOG"
skip=0
for a do
  shift
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in -o|-g) skip=1; continue ;; esac
  set -- "$@" "$a"
done
exec /usr/bin/install "$@"
`, 0o755)
	// Inactive firewalls, so the firewall phase never reaches a real host ufw.
	writeFile(t, filepath.Join(s.stubs, "ufw"), "#!/bin/sh\necho \"ufw $*\" >> \"$STUB_LOG\"\necho 'Status: inactive'\n", 0o755)
	writeFile(t, filepath.Join(s.stubs, "firewall-cmd"), "#!/bin/sh\necho \"firewall-cmd $*\" >> \"$STUB_LOG\"\necho 'not running'\nexit 252\n", 0o755)
	state := filepath.Join(s.root, "systemctl-state")
	writeFile(t, filepath.Join(s.stubs, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> "$STUB_LOG"
for a in "$@"; do last="$a"; done
case "$1" in
  is-enabled|is-active) [ -e "$SYSTEMCTL_STATE/$1.$last" ] ;;
  enable) mkdir -p "$SYSTEMCTL_STATE"; touch "$SYSTEMCTL_STATE/is-enabled.$last"; [ "$2" = --now ] && touch "$SYSTEMCTL_STATE/is-active.$last"; exit 0 ;;
  *) exit 0 ;;
esac
`, 0o755)
	return state
}

func stubLines(t *testing.T, s *sandbox, prefix string) []string {
	t.Helper()
	b, err := os.ReadFile(s.stubLog)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, prefix) {
			out = append(out, l)
		}
	}
	return out
}

func TestEngineFullRunAchillesCA(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	state := addFullRunStubs(t, s)
	systemdDir := filepath.Join(s.root, "systemd")
	if err := os.MkdirAll(systemdDir, 0o755); err != nil {
		t.Fatal(err)
	}
	libDir := filepath.Join(t.TempDir(), "lib")
	ov := map[string]string{
		"ACHILLES_RENDER_ONLY":      "",
		"ACHILLES_PROGRESS":         "1",
		"ACHILLES_SYSTEMD_DIR":      systemdDir,
		"ACHILLES_LIB_DIR_OVERRIDE": libDir,
		"SYSTEMCTL_STATE":           state,
	}
	r := s.mustRun(t, ov)
	want := []string{"config", "validate", "docker", "ca", "caddy-render", "backend-env", "root-env", "firewall", "up", "bootstrap", "renew-timer"}
	if got := phaseIDs(t, r); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("phases = %v, want %v", got, want)
	}
	up := "docker compose -f " + s.path("docker-compose.server.yml") + " up -d --build"
	if l := stubLines(t, s, "docker compose"); len(l) == 0 || !strings.Contains(strings.Join(l, "\n"), up) {
		t.Errorf("want %q in docker calls, got %v", up, l)
	}

	svc := readFile(t, filepath.Join(systemdDir, "achilles-ca-renew.service"))
	timer := readFile(t, filepath.Join(systemdDir, "achilles-ca-renew.timer"))
	for _, want := range []string{
		"Type=oneshot",
		`ExecStart=/bin/sh "` + libDir + `/ca-renew.sh"`,
		`Environment="ACHILLES_INSTALLER_BIN=` + libDir + `/achilles-installer"`,
		`Environment="ACHILLES_CA_DIR=` + s.caDir + `"`,
	} {
		if !strings.Contains(svc, want) {
			t.Errorf("service unit lacks %q:\n%s", want, svc)
		}
	}
	// The root service must execute only the root-owned copies, never files
	// in the repo (writable by the install user).
	for _, l := range strings.Split(svc, "\n") {
		if strings.HasPrefix(l, "ExecStart=") {
			for _, f := range strings.Fields(strings.TrimPrefix(l, "ExecStart=")) {
				if f = strings.Trim(f, `"`); f != "/bin/sh" && !strings.HasPrefix(f, libDir+"/") {
					t.Errorf("ExecStart runs %q, outside %s", f, libDir)
				}
			}
		}
	}
	for _, bad := range []string{installerBin, s.path("scripts")} {
		if strings.Contains(svc, bad) {
			t.Errorf("service unit references %q:\n%s", bad, svc)
		}
	}
	for src, dst := range map[string]string{installerBin: "achilles-installer", s.path("scripts", "ca-renew.sh"): "ca-renew.sh"} {
		if got, want := readFile(t, filepath.Join(libDir, dst)), readFile(t, src); got != want {
			t.Errorf("%s/%s differs from %s", libDir, dst, src)
		}
		if fi, err := os.Stat(filepath.Join(libDir, dst)); err != nil {
			t.Error(err)
		} else if fi.Mode().Perm() != 0o755 {
			t.Errorf("%s/%s: mode %o, want 755", libDir, dst, fi.Mode().Perm())
		}
	}
	installs := strings.Join(stubLines(t, s, "install"), "\n")
	for _, want := range []string{
		"install -d -o root -g root -m 0755 " + libDir,
		"install -o root -g root -m 0755 " + installerBin + " " + libDir + "/achilles-installer",
		"install -o root -g root -m 0755 " + s.path("scripts", "ca-renew.sh") + " " + libDir + "/ca-renew.sh",
	} {
		if !strings.Contains(installs, want) {
			t.Errorf("first run lacks %q in install calls:\n%s", want, installs)
		}
	}
	for _, want := range []string{"OnCalendar=weekly", "Persistent=true", "WantedBy=timers.target"} {
		if !strings.Contains(timer, want) {
			t.Errorf("timer unit lacks %q:\n%s", want, timer)
		}
	}
	calls := strings.Join(stubLines(t, s, "systemctl"), "\n")
	for _, want := range []string{"systemctl daemon-reload", "systemctl enable --now achilles-ca-renew.timer"} {
		if !strings.Contains(calls, want) {
			t.Errorf("first run lacks %q in systemctl calls:\n%s", want, calls)
		}
	}
	if !strings.Contains(r.stdout, "--cacert") || strings.Contains(r.stdout, "curl -sk") {
		t.Errorf("achilles-ca health hint should verify against the root, not -k\n%s", r.stdout)
	}
	// The CA dir is root-only (0700): without sudo, curl can't read the root
	// (curl: (77) error setting certificate file), as the E2E run showed.
	if !strings.Contains(r.stdout, "Health:  sudo curl -s --cacert") {
		t.Errorf("achilles-ca health hint must use sudo to read the root-only CA dir\n%s", r.stdout)
	}

	// Second run: identical unit content -> no daemon-reload, no re-enable.
	if err := os.Remove(s.stubLog); err != nil {
		t.Fatal(err)
	}
	r = s.mustRun(t, ov)
	if got := phaseIDs(t, r); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("re-run phases = %v, want %v", got, want)
	}
	calls = strings.Join(stubLines(t, s, "systemctl"), "\n")
	if strings.Contains(calls, "daemon-reload") || strings.Contains(calls, "systemctl enable ") || strings.Contains(calls, "systemctl restart ") {
		t.Errorf("re-run with identical units touched systemd:\n%s", calls)
	}
	// Only the directory is re-asserted; no file is reinstalled.
	for _, l := range stubLines(t, s, "install") {
		if !strings.HasPrefix(l, "install -d ") {
			t.Errorf("re-run reinstalled a file: %s", l)
		}
	}

	// A changed source is reinstalled (just that one), units stay put.
	if err := os.Remove(s.stubLog); err != nil {
		t.Fatal(err)
	}
	writeFile(t, s.path("scripts", "ca-renew.sh"), readFile(t, s.path("scripts", "ca-renew.sh"))+"# changed\n", 0o755)
	s.mustRun(t, ov)
	var files []string
	for _, l := range stubLines(t, s, "install") {
		if !strings.HasPrefix(l, "install -d ") {
			files = append(files, l)
		}
	}
	if len(files) != 1 || !strings.HasSuffix(files[0], " "+libDir+"/ca-renew.sh") {
		t.Errorf("want only ca-renew.sh reinstalled, got %v", files)
	}
	if !strings.HasSuffix(readFile(t, filepath.Join(libDir, "ca-renew.sh")), "# changed\n") {
		t.Error("lib copy of ca-renew.sh not updated")
	}
	if l := stubLines(t, s, "systemctl daemon-reload"); len(l) != 0 {
		t.Errorf("unit content unchanged, but systemd was reloaded: %v", l)
	}
}

func TestEngineFullRunExistingModes(t *testing.T) {
	cases := []struct {
		mode   string
		phases []string
		docker []string // substrings expected among the docker calls
	}{
		{"acme-http", []string{"config", "validate", "docker", "caddy-render", "backend-env", "root-env", "up"}, nil},
		{"acme-dns", []string{"config", "validate", "docker", "caddy-render", "backend-env", "root-env", "up"},
			[]string{"docker build -t projectachilles-caddy:dns-cloudflare --build-arg CADDY_DNS_MODULE=github.com/caddy-dns/cloudflare"}},
		{"internal", []string{"config", "validate", "docker", "caddy-render", "backend-env", "root-env", "up", "ca-export"},
			[]string{"exec -T caddy cat /data/caddy/pki/authorities/local/root.crt"}},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			s := newSandbox(t, c.mode, "")
			addFullRunStubs(t, s)
			r := s.mustRun(t, map[string]string{"ACHILLES_RENDER_ONLY": "", "ACHILLES_PROGRESS": "1", "ACHILLES_SYSTEMD_DIR": filepath.Join(s.root, "systemd")})
			if got := phaseIDs(t, r); strings.Join(got, ",") != strings.Join(c.phases, ",") {
				t.Errorf("phases = %v, want %v", got, c.phases)
			}
			calls := strings.Join(stubLines(t, s, "docker"), "\n")
			for _, want := range append(c.docker, "compose -f "+s.path("docker-compose.server.yml")+" up -d --build") {
				if !strings.Contains(calls, want) {
					t.Errorf("docker calls lack %q:\n%s", want, calls)
				}
			}
			if l := stubLines(t, s, "systemctl"); len(l) > 0 {
				t.Errorf("non-CA mode touched systemd: %v", l)
			}
			if c.mode == "internal" {
				if !strings.Contains(r.stdout, "--enroll") || strings.Contains(r.stdout, "ca_cert") {
					t.Errorf("internal next steps must say trust store before --enroll and not suggest ca_cert:\n%s", r.stdout)
				}
			}
		})
	}
}

// TestEngineFullRunRestartsCaddyOnCAChange: `compose up` leaves a running
// Caddy alone when only its bind-mounted CA files change, and Caddy reads them
// only at start. After `up` the engine restarts Caddy (deleting its cached
// leaves first) when the intermediate is newer than the container, or always
// when this run's `ca` phase changed it, so a rotation takes effect even if
// `up` recreated Caddy, and a plain re-run restarts nothing.
func TestEngineFullRunRestartsCaddyOnCAChange(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	state := addFullRunStubs(t, s)
	// docker stub: `compose ps -q caddy` prints a running container whose
	// start time is $FAKE_STARTED; every other call succeeds.
	writeFile(t, filepath.Join(s.stubs, "docker"), `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  --version) echo "Docker version 0.0.0-stub" ;;
  *" ps -q caddy") echo caddycid ;;
  "inspect -f {{.State.StartedAt}} caddycid") echo "$FAKE_STARTED" ;;
esac
exit 0
`, 0o755)
	systemdDir := filepath.Join(s.root, "systemd")
	if err := os.MkdirAll(systemdDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ov := map[string]string{
		"ACHILLES_RENDER_ONLY":      "",
		"ACHILLES_PROGRESS":         "1",
		"ACHILLES_SYSTEMD_DIR":      systemdDir,
		"ACHILLES_LIB_DIR_OVERRIDE": filepath.Join(t.TempDir(), "lib"),
		"SYSTEMCTL_STATE":           state,
	}
	compose := "docker compose -f " + s.path("docker-compose.server.yml") + " --project-directory " + s.root
	clearLeaves := compose + " exec -T caddy rm -rf /data/caddy/certificates/local"
	restart := compose + " restart caddy"
	inter := filepath.Join(s.caDir, "caddy", "intermediate.crt")
	run := func(started time.Time, extraCfg string) []string {
		t.Helper()
		if err := os.Remove(s.stubLog); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if extraCfg != "" {
			s.setConfig(t, readFile(t, s.cfg)+extraCfg)
		}
		ov["FAKE_STARTED"] = started.UTC().Format(time.RFC3339Nano)
		r := s.mustRun(t, ov)
		if got, want := strings.Join(phaseIDs(t, r), ","), "config,validate,docker,ca,caddy-render,backend-env,root-env,firewall,up,bootstrap,renew-timer"; got != want {
			t.Errorf("phases = %s, want %s", got, want)
		}
		var calls []string
		for _, l := range stubLines(t, s, "docker compose") {
			if strings.Contains(l, " restart ") || strings.Contains(l, " rm -rf ") {
				calls = append(calls, l)
			}
		}
		return calls
	}

	want := []string{clearLeaves, restart}
	// First install: the CA is created in this run, so the leaf cache is
	// cleared and Caddy restarted even though `up` started it after the CA.
	// (The same run covers an install switching to achilles-ca from another
	// TLS mode, whose caddy-data volume caches Caddy's own local-CA leaves.)
	if calls := run(time.Now().Add(time.Hour), ""); strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Fatalf("first install: want %v, got %v", want, calls)
	}
	// Caddy has been running since after the intermediate was written.
	issued := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(inter, issued, issued); err != nil {
		t.Fatal(err)
	}
	started := issued.Add(time.Hour)

	// Re-run with nothing changed: the CA files keep their mtime, no restart.
	if calls := run(started, ""); len(calls) != 0 {
		t.Fatalf("re-run with an unchanged CA restarted Caddy: %v", calls)
	}
	if fi, err := os.Stat(inter); err != nil || !fi.ModTime().Equal(issued) {
		t.Fatalf("re-run rewrote the intermediate (mtime %v, want %v; %v)", fi.ModTime(), issued, err)
	}

	// Re-run with nothing changed and a Caddy started after the intermediate
	// (e.g. `up` recreated it for another reason): still nothing.
	if calls := run(time.Now().Add(time.Hour), ""); len(calls) != 0 {
		t.Fatalf("re-run with an unchanged CA and a recreated Caddy restarted it: %v", calls)
	}

	// CA_ROTATE with changed constraints rotates root + intermediate while
	// Caddy keeps running: one leaf-cache delete, then one restart.
	if calls := run(started, "CA_ROTATE=true\nCA_INCLUDE_IP=false\n"); strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Fatalf("rotation: want %v, got %v", want, calls)
	}

	// A rotation in a run whose `up` also recreated Caddy: its start time is
	// newer than the new intermediate, but the caddy-data volume still caches
	// the old root's leaves, so the delete + restart must happen anyway.
	if calls := run(time.Now().Add(time.Hour), "CA_INCLUDE_IP=true\n"); strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Fatalf("rotation + recreated Caddy: want %v, got %v", want, calls)
	}
}

// ---------------------------------------------------------------------------
// scripts/ca-renew.sh (what the systemd service runs)
// ---------------------------------------------------------------------------

func TestCARenewWrapper(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	fake := filepath.Join(s.stubs, "fake-installer")
	writeFile(t, fake, "#!/bin/sh\necho \"installer $*\" >> \"$STUB_LOG\"\n[ -n \"$FAKE_OUT\" ] && echo \"$FAKE_OUT\"\nexit \"${FAKE_RC:-0}\"\n", 0o755)
	// docker stub: `compose ps -q caddy` prints $FAKE_CID, `inspect` prints
	// $FAKE_STARTED, `compose restart` exits $FAKE_RESTART_RC.
	writeFile(t, filepath.Join(s.stubs, "docker"), `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *" ps -q caddy") [ -n "${FAKE_CID:-}" ] && echo "$FAKE_CID"; exit 0 ;;
  "inspect "*) echo "$FAKE_STARTED"; exit 0 ;;
  *" restart caddy") exit "${FAKE_RESTART_RC:-0}" ;;
esac
exit 0
`, 0o755)
	inter := filepath.Join(s.caDir, "caddy", "intermediate.crt")
	if err := os.MkdirAll(filepath.Dir(inter), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(inter); errors.Is(err, os.ErrNotExist) {
		writeFile(t, inter, "intermediate\n", 0o644)
	}
	started := time.Date(2026, 10, 1, 12, 0, 0, 123456789, time.UTC)
	setIssued := func(at time.Time) {
		t.Helper()
		if err := os.Chtimes(inter, at, at); err != nil {
			t.Fatal(err)
		}
	}
	type opts struct{ out, rc, cid, restartRC string }
	run := func(o opts) result {
		t.Helper()
		if err := os.Remove(s.stubLog); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		return s.exec(t, map[string]string{
			"ACHILLES_INSTALLER_BIN": fake,
			"ACHILLES_CA_DIR":        s.caDir,
			"ACHILLES_REPO_ROOT":     s.root,
			"FAKE_OUT":               o.out,
			"FAKE_RC":                o.rc,
			"FAKE_CID":               o.cid,
			"FAKE_STARTED":           started.Format(time.RFC3339Nano),
			"FAKE_RESTART_RC":        o.restartRC,
		}, []string{"/bin/sh", s.path("scripts", "ca-renew.sh")})
	}
	restart := "docker compose -f " + s.path("docker-compose.server.yml") + " --project-directory " + s.root + " restart caddy"
	restarts := func() []string {
		var r []string
		for _, l := range stubLines(t, s, "docker") {
			if strings.HasSuffix(l, " restart caddy") {
				r = append(r, l)
			}
		}
		return r
	}
	const cid = "caddycid"
	older, newer := started.Add(-time.Hour), started.Add(time.Hour)

	// Intermediate older than the running Caddy: nothing to do.
	setIssued(older)
	r := run(opts{out: "not due", cid: cid})
	if r.code != 0 || len(restarts()) != 0 {
		t.Fatalf("not due, current Caddy: want exit 0 and no restart\n%s\n%v", r, stubLines(t, s, "docker"))
	}
	if l := stubLines(t, s, "installer"); len(l) != 1 || l[0] != "installer ca renew --dir "+s.caDir+" --if-expiring 180d" {
		t.Errorf("installer calls = %v", l)
	}
	if !strings.Contains(strings.Join(stubLines(t, s, "docker"), "\n"), "docker inspect -f {{.State.StartedAt}} "+cid) {
		t.Errorf("want a docker inspect of %s, got %v", cid, stubLines(t, s, "docker"))
	}

	// The timer renewed: the new intermediate is newer than Caddy's start.
	setIssued(newer)
	r = run(opts{out: "renewed", cid: cid})
	if l := restarts(); r.code != 0 || len(l) != 1 || l[0] != restart || !strings.Contains(r.stdout, "caddy restarted") {
		t.Fatalf("renewed: want exit 0 and one %q\n%s\n%v", restart, r, l)
	}

	// A manual `ca renew` happened since Caddy started; this run is "not due"
	// but must still restart.
	r = run(opts{out: "not due", cid: cid})
	if l := restarts(); r.code != 0 || len(l) != 1 {
		t.Fatalf("manual renewal not picked up: want one restart\n%s\n%v", r, l)
	}

	// The renewal errors: the restart check still runs, and the renewal's
	// status is the exit status.
	r = run(opts{rc: "3", cid: cid})
	if l := restarts(); r.code != 3 || len(l) != 1 {
		t.Fatalf("renew error with a newer intermediate: want exit 3 and one restart\n%s\n%v", r, l)
	}
	setIssued(older)
	r = run(opts{rc: "3", cid: cid})
	if r.code != 3 || len(restarts()) != 0 {
		t.Fatalf("renew error, current Caddy: want exit 3 and no restart\n%s", r)
	}

	// A failed restart fails the run; the next run (Caddy still the old
	// container) retries it.
	setIssued(newer)
	if r = run(opts{out: "renewed", cid: cid, restartRC: "1"}); r.code == 0 {
		t.Fatalf("renewed + failed restart: want exit != 0\n%s", r)
	}
	r = run(opts{out: "not due", cid: cid})
	if l := restarts(); r.code != 0 || len(l) != 1 || l[0] != restart {
		t.Fatalf("failed restart not retried: %v\n%s", l, r)
	}

	// Caddy not running: it reads the new files when it next starts.
	r = run(opts{out: "not due"})
	if r.code != 0 || len(restarts()) != 0 {
		t.Fatalf("caddy not running: want exit 0 and no restart\n%s", r)
	}

	// Every restart first deletes the cached leaves (Caddy would keep serving
	// them, chained to the old intermediate or root).
	r = run(opts{out: "renewed", cid: cid})
	var seq []string
	for _, l := range stubLines(t, s, "docker compose") {
		if strings.HasSuffix(l, " restart caddy") || strings.Contains(l, " exec ") {
			seq = append(seq, strings.TrimPrefix(l, "docker compose -f "+s.path("docker-compose.server.yml")+" --project-directory "+s.root+" "))
		}
	}
	if r.code != 0 || strings.Join(seq, "|") != "exec -T caddy rm -rf /data/caddy/certificates/local|restart caddy" {
		t.Fatalf("want the leaf cache deleted, then a restart; got %v\n%s", seq, r)
	}

	// --restart-only (what deploy-server.sh runs after `up`) checks and
	// restarts the same way but never renews, and needs no installer binary.
	if err := os.Remove(s.stubLog); err != nil {
		t.Fatal(err)
	}
	r = s.exec(t, map[string]string{
		"ACHILLES_INSTALLER_BIN": "",
		"ACHILLES_CA_DIR":        s.caDir,
		"ACHILLES_REPO_ROOT":     s.root,
		"FAKE_CID":               cid,
		"FAKE_STARTED":           started.Format(time.RFC3339Nano),
	}, []string{"/bin/sh", s.path("scripts", "ca-renew.sh"), "--restart-only"})
	if r.code != 0 || len(stubLines(t, s, "installer")) != 0 || len(restarts()) != 1 {
		t.Fatalf("--restart-only: want exit 0, no installer call and one restart\n%s\n%v", r, stubLines(t, s, ""))
	}

	// --force restarts (leaf cache first) even when Caddy started after the
	// intermediate; without it the same state restarts nothing.
	restartOnly := func(args ...string) result {
		t.Helper()
		if err := os.Remove(s.stubLog); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		return s.exec(t, map[string]string{
			"ACHILLES_INSTALLER_BIN": "",
			"ACHILLES_CA_DIR":        s.caDir,
			"ACHILLES_REPO_ROOT":     s.root,
			"FAKE_CID":               cid,
			"FAKE_STARTED":           started.Format(time.RFC3339Nano),
		}, append([]string{"/bin/sh", s.path("scripts", "ca-renew.sh")}, args...))
	}
	setIssued(older)
	if r = restartOnly("--restart-only"); r.code != 0 || len(restarts()) != 0 {
		t.Fatalf("--restart-only with a current Caddy: want no restart\n%s", r)
	}
	r = restartOnly("--restart-only", "--force")
	if l := stubLines(t, s, "docker compose"); r.code != 0 || len(restarts()) != 1 ||
		!strings.Contains(strings.Join(l, "\n"), " exec -T caddy rm -rf /data/caddy/certificates/local") {
		t.Fatalf("--force: want the leaf cache deleted and one restart\n%s\n%v", r, l)
	}
	if r = restartOnly("--bogus"); r.code != 2 {
		t.Fatalf("unknown argument: want exit 2\n%s", r)
	}
}

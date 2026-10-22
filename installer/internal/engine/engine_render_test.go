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
	wantRoot := readFile(t, testdata(t, "golden", mode+".root.env")) + "CADDY_BIND_IP=\n"
	if got := stripGenerated(readFile(t, s.path(".env"))); got != wantRoot {
		t.Errorf(".env differs from main's + CADDY_BIND_IP=\n--- got ---\n%s--- want ---\n%s", got, wantRoot)
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
	// Human output stays alongside the protocol lines.
	if !strings.Contains(r.stdout, "Validating settings") {
		t.Errorf("human output missing\n%s", r)
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
	want := []string{"config", "validate", "docker", "ca", "caddy-render", "backend-env", "root-env", "up", "bootstrap", "renew-timer"}
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

// ---------------------------------------------------------------------------
// scripts/ca-renew.sh (what the systemd service runs)
// ---------------------------------------------------------------------------

func TestCARenewWrapper(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	fake := filepath.Join(s.stubs, "fake-installer")
	writeFile(t, fake, "#!/bin/sh\necho \"installer $*\" >> \"$STUB_LOG\"\n[ -n \"$FAKE_OUT\" ] && echo \"$FAKE_OUT\"\nexit \"${FAKE_RC:-0}\"\n", 0o755)
	stateDir := filepath.Join(s.root, "state")
	run := func(out, rc, dockerRC string) result {
		t.Helper()
		if err := os.Remove(s.stubLog); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(s.stubs, "docker"), "#!/bin/sh\necho \"docker $*\" >> \"$STUB_LOG\"\nexit "+dockerRC+"\n", 0o755)
		return s.exec(t, map[string]string{
			"ACHILLES_INSTALLER_BIN": fake,
			"ACHILLES_CA_DIR":        s.caDir,
			"ACHILLES_REPO_ROOT":     s.root,
			"ACHILLES_STATE_DIR":     stateDir,
			"FAKE_OUT":               out,
			"FAKE_RC":                rc,
		}, []string{"/bin/sh", s.path("scripts", "ca-renew.sh")})
	}
	restart := "docker compose -f " + s.path("docker-compose.server.yml") + " --project-directory " + s.root + " restart caddy"

	r := run("not due", "0", "0")
	if r.code != 0 || len(stubLines(t, s, "docker")) != 0 {
		t.Fatalf("not due: want exit 0 and no restart\n%s\n%v", r, stubLines(t, s, "docker"))
	}
	if l := stubLines(t, s, "installer"); len(l) != 1 || l[0] != "installer ca renew --dir "+s.caDir+" --if-expiring 180d" {
		t.Errorf("installer calls = %v", l)
	}

	r = run("renewed", "0", "0")
	if l := stubLines(t, s, "docker"); r.code != 0 || len(l) != 1 || l[0] != restart {
		t.Fatalf("renewed: want exit 0 and one %q\n%s\n%v", restart, r, l)
	}

	r = run("", "1", "0")
	if r.code == 0 || len(stubLines(t, s, "docker")) != 0 {
		t.Fatalf("renew error: want exit != 0 and no restart\n%s", r)
	}

	// A failed restart after a renewal is retried by the next (not due) run,
	// so Caddy cannot keep signing with the old intermediate.
	if r = run("renewed", "0", "1"); r.code == 0 {
		t.Fatalf("renewed + failed restart: want exit != 0\n%s", r)
	}
	r = run("not due", "0", "0")
	if l := stubLines(t, s, "docker"); r.code != 0 || len(l) != 1 || l[0] != restart {
		t.Fatalf("pending restart not retried: %v\n%s", l, r)
	}
	r = run("not due", "0", "0")
	if r.code != 0 || len(stubLines(t, s, "docker")) != 0 {
		t.Fatalf("restart repeated after it succeeded\n%s", r)
	}
}

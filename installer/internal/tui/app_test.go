package tui

// Wizard flow tests. Each test drives the real Bubble Tea program through
// teatest with keystrokes. Assertions read the app's own rendered frame
// through a probe message (see driver.frame): the terminal byte stream is
// diff-rendered, so substrings in it are unreliable.
//
// Regenerate the 80x24 frame goldens with:
//
//	go test ./internal/tui/ -run TestFramesFit80x24 -update

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/exp/teatest/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/ca"
	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tlsfiles"
)

// updating reports whether -update was passed (the flag is registered by
// teatest's golden package).
func updating() bool {
	f := flag.Lookup("update")
	return f != nil && f.Value.String() == "true"
}

const (
	testHost = "achilles.corp.example.com"
	testIP   = "10.0.5.20"
)

var testNow = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type fakeSys struct {
	busyPorts   map[int]bool
	mem         uint64          // 0 = 8 GiB
	unreachable map[string]bool // URLs whose HTTPReachable fails
}

func (f fakeSys) MemTotalBytes() (uint64, error) {
	if f.mem != 0 {
		return f.mem, nil
	}
	return 8 << 30, nil
}
func (fakeSys) DiskFreeBytes(string) (uint64, error) { return 100 << 30, nil }
func (f fakeSys) PortFree(p int) bool                { return !f.busyPorts[p] }
func (f fakeSys) HTTPReachable(_ context.Context, url string) error {
	if f.unreachable[url] {
		return errors.New("dial tcp: i/o timeout")
	}
	return nil
}
func (fakeSys) DockerVersion() (string, error)     { return "27.3.1", nil }
func (fakeSys) TimeSynced() (bool, error)          { return true, nil }
func (fakeSys) IsRoot() bool                       { return true }
func (fakeSys) DirExists(string) bool              { return false }
func (fakeSys) OSRelease() (string, string, error) { return "ubuntu", "24.04", nil }

type fakeResolver struct {
	ns    map[string]bool
	hosts map[string][]string
}

func notFound(name string) error {
	return &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
}

func (r fakeResolver) LookupNS(_ context.Context, name string) ([]*net.NS, error) {
	if r.ns[name] {
		return []*net.NS{{Host: "ns1." + name + "."}}, nil
	}
	return nil, notFound(name)
}

func (r fakeResolver) LookupHost(_ context.Context, host string) ([]string, error) {
	if a, ok := r.hosts[host]; ok {
		return a, nil
	}
	return nil, notFound(host)
}

func testDeps(t *testing.T) Deps {
	t.Helper()
	root := t.TempDir()
	return Deps{
		System:   fakeSys{},
		Resolver: fakeResolver{ns: map[string]bool{"example.com": true}, hosts: map[string][]string{testHost: {testIP}}},
		Interfaces: func() []sysprobe.Iface {
			return []sysprobe.Iface{{Name: "ens18", IP: testIP, CIDR: "10.0.5.0/24", Default: true}}
		},
		RepoRoot:   root,
		ConfigPath: filepath.Join(root, "deploy.config.env"),
		CADir:      filepath.Join(t.TempDir(), "ca"),
		Now:        func() time.Time { return testNow },
	}
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// probeMsg runs fn on the event-loop goroutine against the current model.
// The program filter swallows it, so the app never sees it.
type probeMsg struct{ fn func(*App) }

type driver struct {
	t  *testing.T
	tm *teatest.TestModel
	// forbid lists strings (e.g. a full secret) that no observed frame may
	// contain.
	forbid []string
}

func start(t *testing.T, d Deps, existing *config.Config) *driver {
	t.Helper()
	filter := func(m tea.Model, msg tea.Msg) tea.Msg {
		if p, ok := msg.(probeMsg); ok {
			p.fn(m.(*App))
			return nil
		}
		return msg
	}
	tm := teatest.NewTestModel(t, New(d, existing),
		teatest.WithInitialTermSize(80, 24),
		teatest.WithProgramOptions(tea.WithFilter(filter)))
	return &driver{t: t, tm: tm}
}

// frame returns the app's current frame with styling stripped.
func (d *driver) frame() (string, bool) {
	ch := make(chan string, 1)
	d.tm.Send(probeMsg{fn: func(a *App) { ch <- ansi.Strip(a.View().Content) }})
	select {
	case f := <-ch:
		return f, true
	case <-time.After(time.Second):
		return "", false
	}
}

// waitFor polls the frame until cond holds. Every frame seen must fit 80x24.
func (d *driver) waitFor(desc string, cond func(string) bool) string {
	d.t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	last := ""
	for time.Now().Before(deadline) {
		f, ok := d.frame()
		if ok {
			last = f
			assertFits(d.t, f, 80, 24)
			for _, x := range d.forbid {
				if strings.Contains(f, x) {
					d.t.Fatalf("frame shows %q:\n%s", x, f)
				}
			}
			if cond(f) {
				return f
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	d.t.Fatalf("timed out waiting for %s; last frame:\n%s", desc, last)
	return ""
}

func (d *driver) waitText(s ...string) string {
	d.t.Helper()
	return d.waitFor(strings.Join(s, " + "), func(f string) bool {
		for _, x := range s {
			if !strings.Contains(f, x) {
				return false
			}
		}
		return true
	})
}

func (d *driver) press(code rune) { d.tm.Send(tea.KeyPressMsg{Code: code}) }
func (d *driver) enter()          { d.press(tea.KeyEnter) }
func (d *driver) esc()            { d.press(tea.KeyEscape) }
func (d *driver) down()           { d.press(tea.KeyDown) }
func (d *driver) up()             { d.press(tea.KeyUp) }
func (d *driver) typ(s string)    { d.tm.Type(s) }
func (d *driver) ctrlC()          { d.tm.Send(tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}) }
func (d *driver) final() *App {
	d.t.Helper()
	return d.tm.FinalModel(d.t, teatest.WithFinalTimeout(8*time.Second)).(*App)
}

// quit aborts the wizard and returns the final model.
func (d *driver) quit() *App {
	d.t.Helper()
	d.ctrlC()
	return d.final()
}

func assertFits(t *testing.T, frame string, w, h int) {
	t.Helper()
	lines := strings.Split(frame, "\n")
	if len(lines) > h {
		t.Fatalf("frame has %d lines, want <= %d:\n%s", len(lines), h, frame)
	}
	for i, l := range lines {
		if n := ansi.StringWidth(l); n > w {
			t.Fatalf("line %d is %d cells wide, want <= %d: %q", i+1, n, w, l)
		}
	}
}

// ---------------------------------------------------------------------------
// Walk helpers
// ---------------------------------------------------------------------------

func (d *driver) passWelcome() {
	d.t.Helper()
	d.waitText("Press enter to start")
	d.enter()
}

func (d *driver) passPreflight() {
	d.t.Helper()
	d.waitText("Preflight", "0 failed")
	d.enter()
}

// passNetwork picks the first interface, types host, accepts the DNS outcome
// (resolving or not: on a mismatch it picks the option at index dnsChoice)
// and the default subnet.
func (d *driver) passNetwork(host string, dnsChoice int) {
	d.t.Helper()
	d.waitText("Network", "ens18")
	d.enter()
	d.waitText("Server hostname")
	d.typ(host)
	d.waitFor("classification", func(f string) bool {
		return strings.Contains(f, "public name servers") || strings.Contains(f, "Private-only")
	})
	d.enter()
	f := d.waitFor("DNS check result", func(f string) bool {
		return strings.Contains(f, "resolves to "+testIP) || strings.Contains(f, "does not resolve")
	})
	if strings.Contains(f, "does not resolve") {
		for range dnsChoice {
			d.down()
		}
	}
	d.enter()
	d.waitText("LAN subnets", "10.0.5.0/24")
	d.enter()
}

// afterCerts waits until the certificates screen has completed (the login
// screen is showing), then aborts and returns the answers applied so far.
func (d *driver) afterCerts() config.Config {
	d.t.Helper()
	d.waitText("Login (Clerk)", "Clerk publishable key")
	return d.quit().cfg
}

func (d *driver) toCerts(host string) {
	d.t.Helper()
	d.passWelcome()
	d.passPreflight()
	d.passNetwork(host, 0)
	d.waitText("Certificates", "ProjectAchilles CA")
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

func TestWizardHappyPathThroughCerts(t *testing.T) {
	d := start(t, testDeps(t), nil)
	d.toCerts(testHost)
	f := d.waitText("Let's Encrypt") // public domain: DNS-01 offered
	if !strings.Contains(f, "4 / 10") {
		t.Errorf("step indicator missing:\n%s", f)
	}
	d.enter() // ProjectAchilles CA (default)
	d.waitText("corp.example.com", "name-constrained")
	d.enter() // zone: nearest candidate (default)
	d.waitText("the IP " + testIP)
	d.enter() // include IP: No (default)

	c := d.afterCerts()
	want := map[string]string{
		"CADDY_BIND_IP": c.CaddyBindIP, "LAN_SUBNETS": c.LANSubnets, "TLS_MODE": c.TLSMode,
		"CA_ZONE": c.CAZone, "ACHILLES_DOMAIN": c.AchillesDomain,
	}
	exp := map[string]string{
		"CADDY_BIND_IP": testIP, "LAN_SUBNETS": "10.0.5.0/24", "TLS_MODE": "achilles-ca",
		"CA_ZONE": "corp.example.com", "ACHILLES_DOMAIN": testHost,
	}
	for k, v := range exp {
		if want[k] != v {
			t.Errorf("%s = %q, want %q", k, want[k], v)
		}
	}
	if c.CAIncludeIP || c.HostsEntry || c.CARotate {
		t.Errorf("CAIncludeIP=%v HostsEntry=%v CARotate=%v, want all false", c.CAIncludeIP, c.HostsEntry, c.CARotate)
	}
}

func TestPreflightFailBlocksNext(t *testing.T) {
	deps := testDeps(t)
	deps.System = fakeSys{busyPorts: map[int]bool{80: true}}
	d := start(t, deps, nil)
	d.passWelcome()
	d.waitText("FAIL", "Port 80 available", "port 80 is already in use")
	d.enter()
	f := d.waitText("Next is blocked")
	if !strings.Contains(f, "2 / 10") || !strings.Contains(f, "Port 80 available") {
		t.Fatalf("expected to stay on preflight naming the failed check:\n%s", f)
	}
	d.enter()
	if f := d.waitText("Next is blocked"); strings.Contains(f, "Network") {
		t.Fatalf("advanced past a failed preflight:\n%s", f)
	}
	if a := d.quit(); a.Outcome().Action != ActionAbort {
		t.Fatalf("outcome = %v", a.Outcome().Action)
	}
}

func TestDNSMismatchShowsADCommand(t *testing.T) {
	deps := testDeps(t)
	deps.Resolver = fakeResolver{ns: map[string]bool{"example.com": true}} // host has no A record
	d := start(t, deps, nil)
	d.passWelcome()
	d.passPreflight()
	d.waitText("Network", "ens18")
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	d.waitText("public name servers")
	d.enter()
	f := d.waitText("does not resolve", "Add-DnsServerResourceRecordA")
	for _, want := range []string{
		testHost + ".  A  " + testIP,
		`-ZoneName "corp.example.com"`,
		`-Name "achilles"`,
		`-IPv4Address "10.0.5.20"`,
		"/etc/hosts",
	} {
		if !strings.Contains(f, want) {
			t.Errorf("frame missing %q:\n%s", want, f)
		}
	}
	d.down() // "Add an /etc/hosts entry on this server"
	d.enter()
	d.waitText("LAN subnets")
	d.enter()
	d.waitText("Certificates")
	if c := d.quit().cfg; !c.HostsEntry || c.AchillesDomain != testHost {
		t.Fatalf("HostsEntry=%v domain=%q, want true + %s", c.HostsEntry, c.AchillesDomain, testHost)
	}
}

func TestLetsEncryptHiddenForPrivateZone(t *testing.T) {
	deps := testDeps(t)
	deps.Resolver = fakeResolver{hosts: map[string][]string{"achilles.corp.lan": {testIP}}}
	d := start(t, deps, nil)
	d.passWelcome()
	d.passPreflight()
	d.passNetwork("achilles.corp.lan", 0)
	f := d.waitText("Certificates", "ProjectAchilles CA", "Bring your own")
	if strings.Contains(f, "DNS-01") || strings.Contains(f, "HTTP-01") {
		t.Fatalf("Let's Encrypt offered for a private-only name:\n%s", f)
	}
	d.quit()
}

// signedPair returns a chain for host signed by a throwaway CA, and its key.
func signedPair(t *testing.T, host string) (chainPEM, keyPEM []byte) {
	t.Helper()
	keyPEM, csrPEM, err := tlsfiles.GenerateCSR(host, "")
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(csrPEM)
	csr, _ := x509.ParseCertificateRequest(blk.Bytes)
	return signCSR(t, csr), keyPEM
}

func signCSR(t *testing.T, csr *x509.CertificateRequest) []byte {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caT := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"},
		NotBefore: testNow.Add(-time.Hour), NotAfter: testNow.AddDate(1, 0, 0),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caT, caT, &caKey.PublicKey, caKey)
	caCert, _ := x509.ParseCertificate(caDER)
	leafT := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: csr.Subject.CommonName},
		DNSNames: csr.DNSNames, IPAddresses: csr.IPAddresses,
		NotBefore: testNow.Add(-time.Hour), NotAfter: testNow.AddDate(0, 3, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, leafT, caCert, csr.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
}

func TestByoRejectsMismatchedKey(t *testing.T) {
	deps := testDeps(t)
	dir := t.TempDir()
	chain, _ := signedPair(t, testHost)
	otherKey, _, _ := tlsfiles.GenerateCSR(testHost, "")
	certPath, keyPath := filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
	os.WriteFile(certPath, chain, 0o644)
	os.WriteFile(keyPath, otherKey, 0o600)

	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down()
	d.down() // Bring your own
	d.enter()
	d.waitText("Certificate chain file")
	d.typ(certPath)
	d.enter()
	d.waitText("Private key file")
	d.typ(keyPath)
	d.enter()
	f := d.waitText("does not match the private key")
	if !strings.Contains(f, "Certificates") {
		t.Fatalf("left the certificates screen:\n%s", f)
	}
	if _, err := os.Stat(filepath.Join(deps.RepoRoot, "deploy", "caddy", "certs", "cert.pem")); !os.IsNotExist(err) {
		t.Fatalf("cert.pem written despite a mismatched key: %v", err)
	}
	d.quit()
}

func TestByoAcceptsMatchingPairAndCopies(t *testing.T) {
	deps := testDeps(t)
	dir := t.TempDir()
	chain, key := signedPair(t, testHost)
	certPath, keyPath := filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
	os.WriteFile(certPath, chain, 0o644)
	os.WriteFile(keyPath, key, 0o600)

	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down()
	d.down()
	d.enter()
	d.waitText("Certificate chain file")
	d.typ(certPath)
	d.enter()
	d.waitText("Private key file")
	d.typ(keyPath)
	d.enter()
	if c := d.afterCerts(); c.TLSMode != "byo" {
		t.Fatalf("TLS_MODE = %q, want byo", c.TLSMode)
	}
	certs := filepath.Join(deps.RepoRoot, "deploy", "caddy", "certs")
	if b, _ := os.ReadFile(filepath.Join(certs, "cert.pem")); string(b) != string(chain) {
		t.Error("cert.pem not copied")
	}
	fi, err := os.Stat(filepath.Join(certs, "key.pem"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("key.pem: %v %v", fi, err)
	}
}

func TestEnterpriseCSRFlow(t *testing.T) {
	deps := testDeps(t)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down() // Enterprise CA
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter() // no IP SAN
	f := d.waitText("BEGIN CERTIFICATE REQUEST", "Signed certificate chain")
	if testing.Verbose() {
		t.Logf("enterprise CSR frame:\n%s", f)
	}
	if !strings.Contains(f, "request.csr") {
		t.Errorf("CSR path not shown:\n%s", f)
	}
	certs := filepath.Join(deps.RepoRoot, "deploy", "caddy", "certs")
	csrPEM, err := os.ReadFile(filepath.Join(certs, "request.csr"))
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(filepath.Join(certs, "key.pem")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key.pem: %v %v", fi, err)
	}
	blk, _ := pem.Decode(csrPEM)
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil || len(csr.DNSNames) != 1 || csr.DNSNames[0] != testHost {
		t.Fatalf("CSR: %v %v", err, csr)
	}

	// A chain for a different key is rejected first.
	wrong, _ := signedPair(t, testHost)
	wrongPath := filepath.Join(t.TempDir(), "wrong.pem")
	os.WriteFile(wrongPath, wrong, 0o644)
	d.typ(wrongPath)
	d.enter()
	d.waitText("does not match the private key")

	signed := filepath.Join(t.TempDir(), "signed.pem")
	chain := signCSR(t, csr)
	os.WriteFile(signed, chain, 0o644)
	// clear the input (ctrl+u) then type the right path
	d.tm.Send(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
	d.typ(signed)
	d.enter()
	if c := d.afterCerts(); c.TLSMode != "byo" {
		t.Fatalf("TLS_MODE = %q, want byo", c.TLSMode)
	}
	if b, _ := os.ReadFile(filepath.Join(certs, "cert.pem")); string(b) != string(chain) {
		t.Error("cert.pem is not the signed chain")
	}
}

// Over a live bring-your-own pair the request's key waits in request.key, so
// the running server's cert.pem/key.pem stay a matching pair until the
// signed chain is imported.
func TestEnterpriseKeepsLivePairUntilImport(t *testing.T) {
	deps := testDeps(t)
	certs := filepath.Join(deps.RepoRoot, "deploy", "caddy", "certs")
	liveChain, liveKey := signedPair(t, testHost)
	os.MkdirAll(certs, 0o755)
	os.WriteFile(filepath.Join(certs, "cert.pem"), liveChain, 0o644)
	os.WriteFile(filepath.Join(certs, "key.pem"), liveKey, 0o600)

	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down()
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter()
	d.waitText("BEGIN CERTIFICATE REQUEST")
	if b, _ := os.ReadFile(filepath.Join(certs, "key.pem")); string(b) != string(liveKey) {
		t.Fatal("generating a request replaced the live key.pem")
	}
	pending, err := os.ReadFile(filepath.Join(certs, "request.key"))
	if err != nil {
		t.Fatal(err)
	}
	csrPEM, _ := os.ReadFile(filepath.Join(certs, "request.csr"))
	blk, _ := pem.Decode(csrPEM)
	csr, _ := x509.ParseCertificateRequest(blk.Bytes)
	chain := signCSR(t, csr)
	signed := filepath.Join(t.TempDir(), "signed.pem")
	os.WriteFile(signed, chain, 0o644)
	d.typ(signed)
	d.enter()
	d.afterCerts()
	if b, _ := os.ReadFile(filepath.Join(certs, "key.pem")); string(b) != string(pending) {
		t.Error("key.pem is not the request's key after import")
	}
	if b, _ := os.ReadFile(filepath.Join(certs, "cert.pem")); string(b) != string(chain) {
		t.Error("cert.pem is not the signed chain")
	}
	if _, err := os.Stat(filepath.Join(certs, "request.key")); !os.IsNotExist(err) {
		t.Errorf("request.key left behind: %v", err)
	}
}

func TestEnterpriseCSRReusedOnReentry(t *testing.T) {
	deps := testDeps(t)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down()
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter()
	d.waitText("BEGIN CERTIFICATE REQUEST")
	certs := filepath.Join(deps.RepoRoot, "deploy", "caddy", "certs")
	first, _ := os.ReadFile(filepath.Join(certs, "key.pem"))
	d.esc() // back to the IP question
	d.waitText("the IP " + testIP)
	d.enter()
	d.waitText("BEGIN CERTIFICATE REQUEST", "existing request")
	if again, _ := os.ReadFile(filepath.Join(certs, "key.pem")); string(again) != string(first) {
		t.Fatal("re-entering the CSR step replaced the key the CA may already be signing")
	}
	d.quit()
}

func TestEscGoesBack(t *testing.T) {
	d := start(t, testDeps(t), nil)
	d.passWelcome()
	d.passPreflight()
	d.waitText("Network", "ens18")
	d.enter()
	d.waitText("Server hostname")
	d.esc()
	d.waitText("Network", "ens18", "Which interface")
	d.esc()
	d.waitText("Preflight", "2 / 10")
	d.esc()
	d.waitText("Press enter to start", "1 / 10")
	d.quit()
}

func existingConfig() *config.Config {
	return &config.Config{
		AchillesDomain: testHost, TLSMode: "achilles-ca", CaddyBindIP: testIP,
		LANSubnets: "10.0.5.0/24", CAZone: "corp.example.com",
		ClerkPublishableKey: "pk_test_x", ClerkSecretKey: "sk_test_x",
		SessionSecret: "s1", EncryptionSecret: "e1", CLIAuthSecret: "c1",
	}
}

func TestWelcomeExistingOffersActions(t *testing.T) {
	d := start(t, testDeps(t), existingConfig())
	f := d.waitText("Reconfigure", "Upgrade", "Status", "Fresh install")
	if !strings.Contains(f, testHost) {
		t.Errorf("existing install not named:\n%s", f)
	}
	d.down() // Upgrade
	d.enter()
	if a := d.final(); a.Outcome().Action != ActionUpgrade {
		t.Fatalf("outcome = %v, want ActionUpgrade", a.Outcome().Action)
	}
}

func TestFreshInstallRequiresTypedHostname(t *testing.T) {
	d := start(t, testDeps(t), existingConfig())
	d.waitText("Fresh install")
	d.down()
	d.down()
	d.down()
	d.enter()
	d.waitText("Type " + testHost)
	d.typ("wrong.example.com")
	d.enter()
	d.waitText("does not match")
	d.tm.Send(tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl})
	d.typ(testHost)
	d.enter()
	d.waitText("Preflight")
	c := d.quit().cfg
	if c.AchillesDomain != "" || c.TLSMode != "" {
		t.Errorf("fresh install kept old answers: %+v", c)
	}
	// Generated secrets survive: the data volumes are encrypted with them.
	if c.SessionSecret != "s1" || c.EncryptionSecret != "e1" || c.CLIAuthSecret != "c1" {
		t.Errorf("fresh install dropped secrets: %q %q %q", c.SessionSecret, c.EncryptionSecret, c.CLIAuthSecret)
	}
}

func TestReconfigureWarnsOnTLSModeChange(t *testing.T) {
	d := start(t, testDeps(t), existingConfig())
	d.waitText("Reconfigure")
	d.enter() // Reconfigure
	d.passPreflight()
	d.waitText("Network", "ens18")
	d.enter()
	d.waitText("Server hostname", testHost) // pre-filled
	d.enter()
	d.waitText("resolves to " + testIP)
	d.enter()
	d.waitText("LAN subnets")
	d.enter()
	d.waitText("Certificates")
	d.down()
	d.down() // Bring your own
	d.enter()
	f := d.waitText("Changing the certificate mode")
	if !strings.Contains(f, "achilles-ca") || !strings.Contains(f, "byo") {
		t.Errorf("warning should name both modes:\n%s", f)
	}
	d.quit()
}

// mkCA creates a real CA bundle in deps.CADir constrained to zone.
func mkCA(t *testing.T, deps Deps, zone string, includeIP bool) {
	t.Helper()
	if _, err := ca.Init(ca.Options{Dir: deps.CADir, Zone: zone, LANIP: testIP, IncludeIP: includeIP}); err != nil {
		t.Fatal(err)
	}
}

func TestCADriftKeepExisting(t *testing.T) {
	deps := testDeps(t)
	mkCA(t, deps, "example.com", false)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.enter()
	d.waitText("name-constrained")
	d.enter() // corp.example.com (differs from the CA's example.com)
	d.waitText("the IP " + testIP)
	d.enter()
	f := d.waitText("existing ProjectAchilles CA", "Keep the existing CA", "Rotate")
	if !strings.Contains(f, "every endpoint") {
		t.Errorf("drift warning should explain re-distribution:\n%s", f)
	}
	d.enter() // keep (default)
	c := d.afterCerts()
	if c.CAZone != "example.com" || c.CAIncludeIP || c.CARotate {
		t.Fatalf("keep: zone=%q includeIP=%v rotate=%v, want example.com/false/false", c.CAZone, c.CAIncludeIP, c.CARotate)
	}
}

func TestCADriftRotate(t *testing.T) {
	deps := testDeps(t)
	mkCA(t, deps, "example.com", false)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.enter()
	d.waitText("name-constrained")
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter()
	d.waitText("Keep the existing CA")
	d.down()
	d.enter()
	c := d.afterCerts()
	if c.CAZone != "corp.example.com" || !c.CARotate {
		t.Fatalf("rotate: zone=%q rotate=%v", c.CAZone, c.CARotate)
	}
}

// When the hostname is outside the existing CA's zone, keeping it isn't
// possible. Rotating is then an explicit Yes on a confirm that defaults to
// No, so a bare enter never commits a fleet-wide root rotation.
func TestCADriftOutsideZoneEnterDoesNotRotate(t *testing.T) {
	deps := testDeps(t)
	mkCA(t, deps, "lab.example.com", false)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.enter()
	d.waitText("name-constrained")
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter()
	f := d.waitText("Rotate the root CA?", "outside lab.example.com")
	checkGolden(t, "13-certs-ca-rotate-confirm", f)
	if !strings.Contains(f, "every endpoint") {
		t.Errorf("confirm should say every endpoint must re-trust:\n%s", f)
	}
	if strings.Contains(f, "Keep the existing CA") {
		t.Errorf("keep offered although the hostname is outside the zone:\n%s", f)
	}
	d.enter() // default: No
	d.waitFor("back on the zone choice", func(f string) bool {
		return strings.Contains(f, "name-constrained") && !strings.Contains(f, "Rotate the root CA?")
	})
	a := d.quit()
	if a.Outcome().Action != ActionAbort {
		t.Fatalf("wizard finished after a bare enter: %v", a.Outcome().Action)
	}
	if a.Outcome().Config.CARotate {
		t.Fatal("CA_ROTATE set by a bare enter")
	}
}

func TestCADriftOutsideZoneExplicitYesRotates(t *testing.T) {
	deps := testDeps(t)
	mkCA(t, deps, "lab.example.com", false)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.enter()
	d.waitText("name-constrained")
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter()
	d.waitText("Rotate the root CA?")
	d.press(tea.KeyLeft) // move to "Yes"
	d.enter()
	c := d.afterCerts()
	if !c.CARotate || c.CAZone != "corp.example.com" {
		t.Fatalf("rotate=%v zone=%q, want true / corp.example.com", c.CARotate, c.CAZone)
	}
}

func TestCANoDriftWhenMatching(t *testing.T) {
	deps := testDeps(t)
	mkCA(t, deps, "corp.example.com", false)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.enter()
	d.waitText("existing CA")
	d.enter()
	d.waitText("the IP " + testIP)
	d.enter()
	c := d.afterCerts()
	if c.CAZone != "corp.example.com" || c.CARotate {
		t.Fatalf("zone=%q rotate=%v", c.CAZone, c.CARotate)
	}
}

func TestPlainModeRefusesWithoutTTY(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	cases := []struct {
		name    string
		in, out any
		term    string
	}{
		{"pipes", r, w, "xterm-256color"},
		{"dumb terminal", r, w, "dumb"},
		{"not files", strings.NewReader(""), &strings.Builder{}, "xterm"},
	}
	for _, c := range cases {
		err := CheckInteractive(c.in, c.out, c.term)
		if err == nil || !strings.Contains(err.Error(), "install --config FILE --yes") {
			t.Errorf("%s: err = %v, want a refusal pointing to install --config FILE --yes", c.name, err)
		}
	}
}

// ---------------------------------------------------------------------------
// 80x24 frames
// ---------------------------------------------------------------------------

func checkGolden(t *testing.T, name, frame string) {
	t.Helper()
	path := filepath.Join("testdata", "frames", name+".golden")
	if updating() {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(frame), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to create)", err)
	}
	if string(want) != frame {
		t.Errorf("frame %s differs from golden (run with -update):\n--- got ---\n%s\n--- want ---\n%s", name, frame, want)
	}
}

func TestFramesFit80x24(t *testing.T) {
	deps := testDeps(t)
	deps.Resolver = fakeResolver{ns: map[string]bool{"example.com": true}}
	mkCA(t, deps, "example.com", false)
	deps.RepoRoot = "/opt/projectachilles-test" // shown in paths; never written in this walk
	d := start(t, deps, nil)

	checkGolden(t, "01-welcome", d.waitText("Press enter to start"))
	d.enter()
	checkGolden(t, "02-preflight", d.waitText("Preflight", "0 failed"))
	d.enter()
	checkGolden(t, "03-network-interface", d.waitText("Network", "ens18"))
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	checkGolden(t, "04-network-hostname", d.waitText("public name servers"))
	d.enter()
	checkGolden(t, "05-network-dns-mismatch", d.waitText("Add-DnsServerResourceRecordA"))
	d.down()
	d.enter()
	checkGolden(t, "06-network-subnets", d.waitText("LAN subnets"))
	d.enter()
	checkGolden(t, "07-certs-mode", d.waitText("Certificates", "Let's Encrypt"))
	d.enter()
	checkGolden(t, "08-certs-zone", d.waitText("name-constrained"))
	d.enter()
	checkGolden(t, "26-certs-ip", d.waitText("the IP "+testIP, "reachable by IP"))
	d.enter()
	checkGolden(t, "09-certs-ca-drift", d.waitText("Keep the existing CA"))
	d.quit()
}

// The include-IP questions must not suggest that https://<ip> will work: the
// site address is the DNS name only.
func TestFramesCertsIPWording(t *testing.T) {
	deps := testDeps(t)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down() // Enterprise CA
	d.enter()
	f := d.waitText("the IP "+testIP, "reachable by IP")
	checkGolden(t, "27-certs-enterprise-ip", f)
	flat := strings.Join(strings.Fields(strings.ReplaceAll(f, "┃", "")), " ")
	if !strings.Contains(flat, "it does not make the server reachable by IP") || strings.Contains(flat, "connect by IP") {
		t.Errorf("enterprise IP question wording:\n%s", f)
	}
	d.quit()
}

func TestFramesExistingAndBlocked(t *testing.T) {
	deps := testDeps(t)
	deps.System = fakeSys{busyPorts: map[int]bool{443: true}}
	deps.ConfigPath = "/opt/projectachilles/deploy.config.env" // shown on the frame
	d := start(t, deps, existingConfig())
	checkGolden(t, "10-welcome-existing", d.waitText("Fresh install"))
	d.quit()

	d = start(t, deps, nil)
	d.passWelcome()
	d.waitText("FAIL")
	d.enter()
	checkGolden(t, "11-preflight-blocked", d.waitText("Next is blocked"))
	d.quit()
}

func TestFramesEnterpriseAndAcme(t *testing.T) {
	deps := testDeps(t)
	d := start(t, deps, nil)
	d.toCerts(testHost)
	d.down()
	d.down()
	d.down() // Let's Encrypt DNS-01
	d.enter()
	checkGolden(t, "12-certs-acme-dns", d.waitText("Email for Let's Encrypt"))
	d.quit()
}

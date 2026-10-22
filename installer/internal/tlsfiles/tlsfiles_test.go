package tlsfiles

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const host = "achilles.corp.example.com"

var now = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

// testCA is a throwaway issuing CA for signing CSRs in tests.
type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newTestCA(t *testing.T) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Enterprise CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour * 365),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return testCA{c, key}
}

type leafOpts struct {
	dns       []string
	ips       []net.IP
	notBefore time.Time
	notAfter  time.Time
	eku       []x509.ExtKeyUsage
}

func (ca testCA) sign(t *testing.T, pub crypto.PublicKey, o leafOpts) []byte {
	t.Helper()
	if o.notBefore.IsZero() {
		o.notBefore = now.Add(-time.Hour)
	}
	if o.notAfter.IsZero() {
		o.notAfter = now.Add(90 * 24 * time.Hour)
	}
	if o.eku == nil {
		o.eku = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "leaf"},
		DNSNames:     o.dns,
		IPAddresses:  o.ips,
		NotBefore:    o.notBefore,
		NotAfter:     o.notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  o.eku,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, pub, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func (ca testCA) pem() []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.cert.Raw})
}

func parseCSR(t *testing.T, csrPEM []byte) *x509.CertificateRequest {
	t.Helper()
	blk, _ := pem.Decode(csrPEM)
	if blk == nil || blk.Type != "CERTIFICATE REQUEST" {
		t.Fatalf("not a PEM CSR:\n%s", csrPEM)
	}
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := csr.CheckSignature(); err != nil {
		t.Fatal(err)
	}
	return csr
}

func mustKey(t *testing.T, keyPEM []byte) crypto.Signer {
	t.Helper()
	k, err := ParseKey(keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestGenerateCSRP256WithSAN(t *testing.T) {
	keyPEM, csrPEM, err := GenerateCSR(host, "")
	if err != nil {
		t.Fatal(err)
	}
	csr := parseCSR(t, csrPEM)
	if len(csr.DNSNames) != 1 || csr.DNSNames[0] != host || len(csr.IPAddresses) != 0 {
		t.Fatalf("SANs = %v %v", csr.DNSNames, csr.IPAddresses)
	}
	if csr.Subject.CommonName != host {
		t.Errorf("CN = %q", csr.Subject.CommonName)
	}
	pub, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("key is not ECDSA P-256: %T", csr.PublicKey)
	}
	if blk, _ := pem.Decode(keyPEM); blk == nil || blk.Type != "PRIVATE KEY" {
		t.Fatalf("key is not PKCS#8 PEM")
	}
	if !mustKey(t, keyPEM).Public().(*ecdsa.PublicKey).Equal(pub) {
		t.Fatal("CSR public key does not match the key")
	}
}

func TestGenerateCSRWithIP(t *testing.T) {
	_, csrPEM, err := GenerateCSR(host, "10.0.5.20")
	if err != nil {
		t.Fatal(err)
	}
	csr := parseCSR(t, csrPEM)
	if len(csr.IPAddresses) != 1 || !csr.IPAddresses[0].Equal(net.ParseIP("10.0.5.20")) {
		t.Fatalf("IPs = %v", csr.IPAddresses)
	}
	if _, _, err := GenerateCSR(host, "not-an-ip"); err == nil {
		t.Fatal("want error for a bad IP")
	}
	if _, _, err := GenerateCSR("", ""); err == nil {
		t.Fatal("want error for an empty host")
	}
}

func TestCSRMatches(t *testing.T) {
	keyPEM, csrPEM, err := GenerateCSR(host, "10.0.5.20")
	if err != nil {
		t.Fatal(err)
	}
	if !CSRMatches(keyPEM, csrPEM, host, "10.0.5.20") {
		t.Fatal("want match")
	}
	if CSRMatches(keyPEM, csrPEM, host, "") {
		t.Error("IP set differs: want no match")
	}
	if CSRMatches(keyPEM, csrPEM, "other.corp.example.com", "10.0.5.20") {
		t.Error("host differs: want no match")
	}
	otherKey, _, _ := GenerateCSR(host, "10.0.5.20")
	if CSRMatches(otherKey, csrPEM, host, "10.0.5.20") {
		t.Error("key differs: want no match")
	}
	if CSRMatches([]byte("junk"), csrPEM, host, "10.0.5.20") {
		t.Error("junk key: want no match")
	}
}

func TestValidatePairAcceptsSignedChain(t *testing.T) {
	ca := newTestCA(t)
	keyPEM, csrPEM, _ := GenerateCSR(host, "")
	csr := parseCSR(t, csrPEM)
	chain := append(ca.sign(t, csr.PublicKey, leafOpts{dns: csr.DNSNames}), ca.pem()...)
	if err := ValidatePair(chain, keyPEM, host, "", now); err != nil {
		t.Fatalf("ValidatePair: %v", err)
	}
	// Leaf alone is fine too.
	if err := ValidatePair(ca.sign(t, csr.PublicKey, leafOpts{dns: csr.DNSNames}), keyPEM, host, "", now); err != nil {
		t.Fatalf("leaf only: %v", err)
	}
}

func TestValidatePairRejections(t *testing.T) {
	ca := newTestCA(t)
	keyPEM, csrPEM, _ := GenerateCSR(host, "")
	pub := parseCSR(t, csrPEM).PublicKey
	otherKey, _, _ := GenerateCSR(host, "")

	cases := []struct {
		name  string
		chain []byte
		key   []byte
		ip    string
		want  string
	}{
		{"mismatched key", ca.sign(t, pub, leafOpts{dns: []string{host}}), otherKey, "", "does not match the private key"},
		{"wrong host", ca.sign(t, pub, leafOpts{dns: []string{"other.example.com"}}), keyPEM, "", "not valid for " + host},
		{"missing IP", ca.sign(t, pub, leafOpts{dns: []string{host}}), keyPEM, "10.0.5.20", "not valid for 10.0.5.20"},
		{"expired", ca.sign(t, pub, leafOpts{dns: []string{host}, notBefore: now.AddDate(-1, 0, 0), notAfter: now.AddDate(0, 0, -1)}), keyPEM, "", "expired"},
		{"not yet valid", ca.sign(t, pub, leafOpts{dns: []string{host}, notBefore: now.AddDate(0, 0, 1), notAfter: now.AddDate(1, 0, 0)}), keyPEM, "", "not valid until"},
		{"client auth only", ca.sign(t, pub, leafOpts{dns: []string{host}, eku: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}), keyPEM, "", "server authentication"},
		{"wrong order", append(ca.pem(), ca.sign(t, pub, leafOpts{dns: []string{host}})...), keyPEM, "", "server certificate first"},
		{"no cert", []byte("hello"), keyPEM, "", "no certificate"},
		{"no key", ca.sign(t, pub, leafOpts{dns: []string{host}}), []byte("hello"), "", "no private key"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidatePair(c.chain, c.key, host, c.ip, now)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to contain %q", err, c.want)
			}
		})
	}
}

func TestParseKeyFormats(t *testing.T) {
	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs1 := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rk)})
	if _, err := ParseKey(pkcs1); err != nil {
		t.Errorf("PKCS#1: %v", err)
	}
	ek, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalECPrivateKey(ek)
	sec1 := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	// openssl prepends EC PARAMETERS; it must be skipped.
	withParams := append([]byte("-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n"), sec1...)
	if _, err := ParseKey(withParams); err != nil {
		t.Errorf("SEC1 with params: %v", err)
	}
	ca := newTestCA(t)
	chain := ca.sign(t, &rk.PublicKey, leafOpts{dns: []string{host}})
	if err := ValidatePair(chain, pkcs1, host, "", now); err != nil {
		t.Errorf("RSA pair: %v", err)
	}
}

func TestLoadPairReadsFiles(t *testing.T) {
	dir := t.TempDir()
	ca := newTestCA(t)
	keyPEM, csrPEM, _ := GenerateCSR(host, "")
	chain := ca.sign(t, parseCSR(t, csrPEM).PublicKey, leafOpts{dns: []string{host}})
	cp, kp := filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	os.WriteFile(cp, chain, 0o644)
	os.WriteFile(kp, keyPEM, 0o600)
	gotC, gotK, err := LoadPair(cp, kp, host, "", now)
	if err != nil || string(gotC) != string(chain) || string(gotK) != string(keyPEM) {
		t.Fatalf("LoadPair: %v", err)
	}
	if _, _, err := LoadPair(filepath.Join(dir, "missing.pem"), kp, host, "", now); err == nil || !strings.Contains(err.Error(), "missing.pem") {
		t.Fatalf("want a read error naming the file, got %v", err)
	}
}

func TestWriteFileAtomicMode(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "key.pem")
	if err := WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, %v", fi.Mode(), err)
	}
	if err := WriteFile(p, []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "y" {
		t.Fatalf("content = %q", b)
	}
}

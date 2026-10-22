package ca

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const zone = "corp.example.com"

var t0 = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

func fixedNow(t time.Time) func() time.Time { return func() time.Time { return t } }

func opts(t *testing.T) Options {
	t.Helper()
	return Options{
		Dir:   filepath.Join(t.TempDir(), "ca"),
		Zone:  zone,
		LANIP: "10.0.5.20",
		Label: "Acme Corp",
		Now:   fixedNow(t0),
	}
}

func mustInit(t *testing.T, o Options) *Bundle {
	t.Helper()
	b, err := Init(o)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	return b
}

func readCert(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(data)
	if blk == nil || blk.Type != "CERTIFICATE" {
		t.Fatalf("%s: not a PEM certificate", path)
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func readKey(t *testing.T, path string) *ecdsa.PrivateKey {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(data)
	if blk == nil || blk.Type != "PRIVATE KEY" {
		t.Fatalf("%s: not a PKCS#8 PEM key", path)
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	ek, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		t.Fatalf("%s: key is %T, want *ecdsa.PrivateKey", path, k)
	}
	return ek
}

func within(got, want, tol time.Duration) bool {
	d := got - want
	if d < 0 {
		d = -d
	}
	return d <= tol
}

func isP256(t *testing.T, c *x509.Certificate) {
	t.Helper()
	pub, ok := c.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("%s: public key %T is not ECDSA P-256", c.Subject.CommonName, c.PublicKey)
	}
}

func hasCriticalExt(c *x509.Certificate, oid []int) bool {
	for _, e := range c.Extensions {
		if e.Id.Equal(oid) {
			return e.Critical
		}
	}
	return false
}

var oidNameConstraints = []int{2, 5, 29, 30}

func assertConstraints(t *testing.T, c *x509.Certificate) {
	t.Helper()
	if !c.PermittedDNSDomainsCritical || !hasCriticalExt(c, oidNameConstraints) {
		t.Errorf("%s: name constraints not critical", c.Subject.CommonName)
	}
	if !reflect.DeepEqual(c.PermittedDNSDomains, []string{zone}) {
		t.Errorf("%s: PermittedDNSDomains = %v, want [%s]", c.Subject.CommonName, c.PermittedDNSDomains, zone)
	}
	if !reflect.DeepEqual(c.ExtKeyUsage, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}) {
		t.Errorf("%s: ExtKeyUsage = %v, want [serverAuth]", c.Subject.CommonName, c.ExtKeyUsage)
	}
	if len(c.UnknownExtKeyUsage) != 0 {
		t.Errorf("%s: unexpected unknown EKUs %v", c.Subject.CommonName, c.UnknownExtKeyUsage)
	}
	if want := x509.KeyUsageCertSign | x509.KeyUsageCRLSign; c.KeyUsage != want {
		t.Errorf("%s: KeyUsage = %v, want CertSign|CRLSign", c.Subject.CommonName, c.KeyUsage)
	}
	if !c.IsCA || !c.BasicConstraintsValid {
		t.Errorf("%s: not a CA", c.Subject.CommonName)
	}
}

func ipNets(ns []*net.IPNet) []string {
	var out []string
	for _, n := range ns {
		out = append(out, n.String())
	}
	return out
}

func TestInitRootProperties(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	r := b.Root
	isP256(t, r)
	assertConstraints(t, r)
	if !within(r.NotAfter.Sub(t0), t0.AddDate(10, 0, 0).Sub(t0), 24*time.Hour) {
		t.Errorf("root NotAfter = %v, want ~10y after %v", r.NotAfter, t0)
	}
	if r.NotBefore.After(t0) {
		t.Errorf("root NotBefore %v is after now", r.NotBefore)
	}
	if want := "ProjectAchilles Root CA – Acme Corp"; r.Subject.CommonName != want {
		t.Errorf("root CN = %q, want %q", r.Subject.CommonName, want)
	}
	if err := r.CheckSignatureFrom(r); err != nil {
		t.Errorf("root not self-signed: %v", err)
	}
	if len(r.SubjectKeyId) != 20 {
		t.Errorf("root SubjectKeyId len = %d, want 20 (SHA-1)", len(r.SubjectKeyId))
	}
	if r.SerialNumber.Sign() <= 0 || r.SerialNumber.BitLen() < 64 {
		t.Errorf("root serial %v is not a large positive random number", r.SerialNumber)
	}
	if b.Dir != o.Dir {
		t.Errorf("Bundle.Dir = %q, want %q", b.Dir, o.Dir)
	}
	// The file on disk is the same certificate.
	if disk := readCert(t, filepath.Join(o.Dir, "root.crt")); !disk.Equal(r) {
		t.Error("root.crt on disk differs from returned root")
	}
}

func TestInitIntermediateProperties(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	in := b.Intermediate
	isP256(t, in)
	assertConstraints(t, in)
	if in.MaxPathLen != 0 || !in.MaxPathLenZero {
		t.Errorf("intermediate MaxPathLen=%d MaxPathLenZero=%v, want 0/true", in.MaxPathLen, in.MaxPathLenZero)
	}
	if !within(in.NotAfter.Sub(t0), t0.AddDate(2, 0, 0).Sub(t0), 24*time.Hour) {
		t.Errorf("intermediate NotAfter = %v, want ~2y after %v", in.NotAfter, t0)
	}
	if err := in.CheckSignatureFrom(b.Root); err != nil {
		t.Errorf("intermediate not signed by root: %v", err)
	}
	if !bytes.Equal(in.AuthorityKeyId, b.Root.SubjectKeyId) {
		t.Error("intermediate AuthorityKeyId != root SubjectKeyId")
	}
	if want := "ProjectAchilles Intermediate CA – Acme Corp"; in.Subject.CommonName != want {
		t.Errorf("intermediate CN = %q, want %q", in.Subject.CommonName, want)
	}
	if !reflect.DeepEqual(ipNets(in.ExcludedIPRanges), ipNets(b.Root.ExcludedIPRanges)) ||
		!reflect.DeepEqual(ipNets(in.PermittedIPRanges), ipNets(b.Root.PermittedIPRanges)) {
		t.Error("intermediate IP constraints differ from root")
	}
	// Intermediate key on disk matches the certificate.
	k := readKey(t, filepath.Join(o.Dir, "caddy", "intermediate.key"))
	if !k.PublicKey.Equal(in.PublicKey) {
		t.Error("caddy/intermediate.key does not match intermediate certificate")
	}
	rk := readKey(t, filepath.Join(o.Dir, "root.key"))
	if !rk.PublicKey.Equal(b.Root.PublicKey) {
		t.Error("root.key does not match root certificate")
	}
}

func TestExcludesAllIPsWhenNotIncluded(t *testing.T) {
	b := mustInit(t, opts(t))
	for _, c := range []*x509.Certificate{b.Root, b.Intermediate} {
		got := ipNets(c.ExcludedIPRanges)
		if !reflect.DeepEqual(got, []string{"0.0.0.0/0", "::/0"}) {
			t.Errorf("%s: ExcludedIPRanges = %v", c.Subject.CommonName, got)
		}
		if len(c.PermittedIPRanges) != 0 {
			t.Errorf("%s: PermittedIPRanges = %v, want none", c.Subject.CommonName, ipNets(c.PermittedIPRanges))
		}
	}
}

func TestPermitsOnlyLANIPWhenIncluded(t *testing.T) {
	o := opts(t)
	o.IncludeIP = true
	b := mustInit(t, o)
	for _, c := range []*x509.Certificate{b.Root, b.Intermediate} {
		if got := ipNets(c.PermittedIPRanges); !reflect.DeepEqual(got, []string{"10.0.5.20/32"}) {
			t.Errorf("%s: PermittedIPRanges = %v", c.Subject.CommonName, got)
		}
		if len(c.ExcludedIPRanges) != 0 {
			t.Errorf("%s: ExcludedIPRanges = %v, want none", c.Subject.CommonName, ipNets(c.ExcludedIPRanges))
		}
	}
}

func TestIncludeIPRequiresValidLANIP(t *testing.T) {
	for _, ip := range []string{"", "not-an-ip", "10.0.5.0/24"} {
		o := opts(t)
		o.IncludeIP = true
		o.LANIP = ip
		if _, err := Init(o); err == nil {
			t.Errorf("IncludeIP with LANIP %q: want error", ip)
		}
	}
}

func TestInitRejectsUnsafeZones(t *testing.T) {
	for _, z := range []string{"", "com", "co.uk", "corp", "*.corp.example.com", ".corp.example.com", "10.0.0.1", "bad_zone.example.com"} {
		o := opts(t)
		o.Zone = z
		if _, err := Init(o); err == nil {
			t.Errorf("zone %q: want error", z)
		}
		if _, err := os.Stat(filepath.Join(o.Dir, "root.key")); err == nil {
			t.Errorf("zone %q: root.key written despite rejection", z)
		}
	}
}

func TestInitNormalisesZone(t *testing.T) {
	o := opts(t)
	o.Zone = "  Corp.Example.COM. "
	b := mustInit(t, o)
	if !reflect.DeepEqual(b.Root.PermittedDNSDomains, []string{zone}) {
		t.Errorf("PermittedDNSDomains = %v", b.Root.PermittedDNSDomains)
	}
}

// --- leaf issuance helpers ---------------------------------------------------

type leafSpec struct {
	dns []string
	ips []string
}

func issueLeaf(t *testing.T, parent *x509.Certificate, parentKey crypto.Signer, s leafSpec) *x509.Certificate {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(4242),
		Subject:      pkix.Name{CommonName: "leaf"},
		NotBefore:    t0.Add(-time.Hour),
		NotAfter:     t0.Add(90 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     s.dns,
	}
	for _, ip := range s.ips {
		tmpl.IPAddresses = append(tmpl.IPAddresses, net.ParseIP(ip))
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &k.PublicKey, parentKey)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func verifyLeaf(leaf, root, inter *x509.Certificate, at time.Time) error {
	roots, inters := x509.NewCertPool(), x509.NewCertPool()
	roots.AddCert(root)
	inters.AddCert(inter)
	_, err := leaf.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: inters,
		CurrentTime:   at,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	return err
}

// unconstrainedTwin builds a control chain: a fresh root with no constraints and
// an intermediate certificate for the SAME intermediate key and subject, also
// unconstrained. A leaf signed by the real intermediate key verifies against
// this chain, which proves that any rejection by the real chain comes from the
// name constraints and not from a malformed test leaf.
func unconstrainedTwin(t *testing.T, real *x509.Certificate) (root, inter *x509.Certificate) {
	t.Helper()
	rk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rt := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "control root"},
		NotBefore:             t0.Add(-time.Hour),
		NotAfter:              t0.AddDate(1, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	rder, err := x509.CreateCertificate(rand.Reader, rt, rt, &rk.PublicKey, rk)
	if err != nil {
		t.Fatal(err)
	}
	root, _ = x509.ParseCertificate(rder)
	it := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               real.Subject,
		SubjectKeyId:          real.SubjectKeyId,
		NotBefore:             t0.Add(-time.Hour),
		NotAfter:              t0.AddDate(1, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	ider, err := x509.CreateCertificate(rand.Reader, it, root, real.PublicKey, rk)
	if err != nil {
		t.Fatal(err)
	}
	inter, _ = x509.ParseCertificate(ider)
	return root, inter
}

func interKey(t *testing.T, dir string) *ecdsa.PrivateKey {
	return readKey(t, filepath.Join(dir, "caddy", "intermediate.key"))
}

func TestInZoneLeafVerifies(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	k := interKey(t, o.Dir)
	for _, name := range []string{"achilles.corp.example.com", "corp.example.com", "a.b.corp.example.com"} {
		leaf := issueLeaf(t, b.Intermediate, k, leafSpec{dns: []string{name}})
		if err := verifyLeaf(leaf, b.Root, b.Intermediate, t0); err != nil {
			t.Errorf("%s: in-zone leaf rejected: %v", name, err)
		}
	}
}

func TestOutOfZoneLeafRejected(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	k := interKey(t, o.Dir)
	croot, cinter := unconstrainedTwin(t, b.Intermediate)
	for _, name := range []string{
		"login.microsoftonline.com",
		"evilcorp.example.com",
		"corp.example.com.evil.net",
		"example.com",
	} {
		leaf := issueLeaf(t, b.Intermediate, k, leafSpec{dns: []string{name}})
		if err := verifyLeaf(leaf, croot, cinter, t0); err != nil {
			t.Fatalf("%s: control chain rejected the leaf, test is invalid: %v", name, err)
		}
		err := verifyLeaf(leaf, b.Root, b.Intermediate, t0)
		var ci x509.CertificateInvalidError
		if !errors.As(err, &ci) || ci.Reason != x509.CANotAuthorizedForThisName {
			t.Errorf("%s: want CANotAuthorizedForThisName, got %v", name, err)
		}
	}
	// A mixed leaf (one in-zone, one out-of-zone SAN) is rejected too.
	leaf := issueLeaf(t, b.Intermediate, k, leafSpec{dns: []string{"achilles.corp.example.com", "login.microsoftonline.com"}})
	if err := verifyLeaf(leaf, b.Root, b.Intermediate, t0); err == nil {
		t.Error("mixed in/out-of-zone leaf verified")
	}
}

func TestIPLeafRejectedWhenExcluded(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	k := interKey(t, o.Dir)
	croot, cinter := unconstrainedTwin(t, b.Intermediate)
	for _, ip := range []string{"10.0.5.20", "8.8.8.8", "2001:db8::1"} {
		leaf := issueLeaf(t, b.Intermediate, k, leafSpec{dns: []string{"achilles.corp.example.com"}, ips: []string{ip}})
		if err := verifyLeaf(leaf, croot, cinter, t0); err != nil {
			t.Fatalf("%s: control chain rejected the leaf: %v", ip, err)
		}
		err := verifyLeaf(leaf, b.Root, b.Intermediate, t0)
		var ci x509.CertificateInvalidError
		if !errors.As(err, &ci) || ci.Reason != x509.CANotAuthorizedForThisName {
			t.Errorf("IP %s: want CANotAuthorizedForThisName, got %v", ip, err)
		}
	}
}

func TestIPLeafOnlyLANIPWhenIncluded(t *testing.T) {
	o := opts(t)
	o.IncludeIP = true
	b := mustInit(t, o)
	k := interKey(t, o.Dir)
	ok := issueLeaf(t, b.Intermediate, k, leafSpec{dns: []string{"achilles.corp.example.com"}, ips: []string{"10.0.5.20"}})
	if err := verifyLeaf(ok, b.Root, b.Intermediate, t0); err != nil {
		t.Errorf("LAN IP leaf rejected: %v", err)
	}
	croot, cinter := unconstrainedTwin(t, b.Intermediate)
	for _, ip := range []string{"10.0.5.21", "2001:db8::1"} {
		leaf := issueLeaf(t, b.Intermediate, k, leafSpec{dns: []string{"achilles.corp.example.com"}, ips: []string{ip}})
		if err := verifyLeaf(leaf, croot, cinter, t0); err != nil {
			t.Fatalf("%s: control chain rejected the leaf: %v", ip, err)
		}
		if err := verifyLeaf(leaf, b.Root, b.Intermediate, t0); err == nil {
			t.Errorf("IP %s outside LANIP/32 verified", ip)
		}
	}
}

func TestCodeSigningLeafRejected(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(99),
		NotBefore:    t0.Add(-time.Hour),
		NotAfter:     t0.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		DNSNames:     []string{"achilles.corp.example.com"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, b.Intermediate, &k.PublicKey, interKey(t, o.Dir))
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	verify := func(root, inter *x509.Certificate) error {
		roots, inters := x509.NewCertPool(), x509.NewCertPool()
		roots.AddCert(root)
		inters.AddCert(inter)
		_, err := leaf.Verify(x509.VerifyOptions{
			Roots: roots, Intermediates: inters, CurrentTime: t0,
			KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		})
		return err
	}
	croot, cinter := unconstrainedTwin(t, b.Intermediate)
	if err := verify(croot, cinter); err != nil {
		t.Fatalf("control chain rejected the code-signing leaf, test is invalid: %v", err)
	}
	err = verify(b.Root, b.Intermediate)
	var ci x509.CertificateInvalidError
	if !errors.As(err, &ci) || ci.Reason != x509.IncompatibleUsage {
		t.Errorf("code-signing leaf: want IncompatibleUsage, got %v", err)
	}
}

// --- idempotency, rotation, self-heal ---------------------------------------

func TestInitIdempotent(t *testing.T) {
	o := opts(t)
	first := mustInit(t, o)
	rootBytes, _ := os.ReadFile(filepath.Join(o.Dir, "root.key"))
	interBytes, _ := os.ReadFile(filepath.Join(o.Dir, "caddy", "intermediate.key"))
	o.Now = fixedNow(t0.Add(48 * time.Hour))
	second := mustInit(t, o)
	if first.Root.SerialNumber.Cmp(second.Root.SerialNumber) != 0 {
		t.Error("root serial changed on re-run")
	}
	if first.Intermediate.SerialNumber.Cmp(second.Intermediate.SerialNumber) != 0 {
		t.Error("intermediate serial changed on re-run")
	}
	r2, _ := os.ReadFile(filepath.Join(o.Dir, "root.key"))
	i2, _ := os.ReadFile(filepath.Join(o.Dir, "caddy", "intermediate.key"))
	if !bytes.Equal(rootBytes, r2) || !bytes.Equal(interBytes, i2) {
		t.Error("keys rewritten on re-run")
	}
}

func TestInitZoneMismatchErrExists(t *testing.T) {
	o := opts(t)
	first := mustInit(t, o)
	o.Zone = "other.example.com"
	_, err := Init(o)
	if !errors.Is(err, ErrExists) {
		t.Fatalf("want ErrExists, got %v", err)
	}
	b, err := Load(o.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if b.Root.SerialNumber.Cmp(first.Root.SerialNumber) != 0 {
		t.Error("root changed after ErrExists")
	}
}

func TestInitRotateReplaces(t *testing.T) {
	o := opts(t)
	first := mustInit(t, o)
	o.Rotate = true
	o.Zone = "other.example.com"
	second := mustInit(t, o)
	if first.Root.SerialNumber.Cmp(second.Root.SerialNumber) == 0 {
		t.Error("root serial unchanged after rotate")
	}
	if first.Root.PublicKey.(*ecdsa.PublicKey).Equal(second.Root.PublicKey) {
		t.Error("root key unchanged after rotate")
	}
	if first.Intermediate.PublicKey.(*ecdsa.PublicKey).Equal(second.Intermediate.PublicKey) {
		t.Error("intermediate key unchanged after rotate")
	}
	if !reflect.DeepEqual(second.Root.PermittedDNSDomains, []string{"other.example.com"}) {
		t.Errorf("rotated zone = %v", second.Root.PermittedDNSDomains)
	}
	// Every on-disk copy reflects the new root.
	for _, p := range []string{"root.crt", "caddy/root.crt", "public/root.crt"} {
		if !readCert(t, filepath.Join(o.Dir, p)).Equal(second.Root) {
			t.Errorf("%s not rotated", p)
		}
	}
	der, _ := os.ReadFile(filepath.Join(o.Dir, "public", "root.cer"))
	if !bytes.Equal(der, second.Root.Raw) {
		t.Error("public/root.cer not rotated")
	}
}

func TestInitRotateIfChanged(t *testing.T) {
	o := opts(t)
	first := mustInit(t, o)
	o.Rotate, o.RotateOnlyIfChanged = true, true

	// Same constraints: kept, however often it re-runs.
	same := mustInit(t, o)
	if same.Root.SerialNumber.Cmp(first.Root.SerialNumber) != 0 {
		t.Fatal("rotated although the constraints are unchanged")
	}

	// IP policy differs (zone equal): rotated once, then stable.
	o.IncludeIP = true
	ipChanged := mustInit(t, o)
	if ipChanged.Root.SerialNumber.Cmp(first.Root.SerialNumber) == 0 {
		t.Fatal("IP policy change did not rotate")
	}
	if len(ipChanged.Root.PermittedIPRanges) != 1 {
		t.Fatalf("rotated root IP constraint = %v", ipChanged.Root.PermittedIPRanges)
	}
	again := mustInit(t, o)
	if again.Root.SerialNumber.Cmp(ipChanged.Root.SerialNumber) != 0 {
		t.Fatal("re-run after a rotation rotated again")
	}

	// Zone differs: rotated.
	o.Zone = "other.example.com"
	zoneChanged := mustInit(t, o)
	if zoneChanged.Root.SerialNumber.Cmp(again.Root.SerialNumber) == 0 ||
		zoneChanged.Root.PermittedDNSDomains[0] != "other.example.com" {
		t.Fatal("zone change did not rotate")
	}
}

// With RotateOnlyIfChanged, a root that can't be read or parsed is an error,
// never a reason to rotate: a sticky CA_ROTATE=true must not silently replace
// a damaged root that every endpoint trusts.
func TestInitRotateIfChangedRefusesUnreadableRoot(t *testing.T) {
	cases := map[string]func(t *testing.T, path string){
		"corrupt PEM": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("-----BEGIN CERTIFICATE-----\ngarbage\n-----END CERTIFICATE-----\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"not PEM": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"unreadable": func(t *testing.T, path string) {
			if os.Geteuid() == 0 {
				t.Skip("root can read 0000 files")
			}
			if err := os.Chmod(path, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.Chmod(path, 0o644) })
		},
	}
	for name, damage := range cases {
		t.Run(name, func(t *testing.T) {
			o := opts(t)
			mustInit(t, o)
			damage(t, filepath.Join(o.Dir, "root.crt"))
			before := snapshotDir(t, o.Dir)
			o.Rotate, o.RotateOnlyIfChanged = true, true
			o.Zone = "other.example.com"
			if _, err := WouldRotate(o); err == nil {
				t.Error("WouldRotate: want an error for an unreadable root")
			}
			if _, err := Init(o); err == nil {
				t.Fatal("Init rotated over an unreadable root")
			}
			if after := snapshotDir(t, o.Dir); !reflect.DeepEqual(before, after) {
				t.Fatal("CA files changed after the refused rotation")
			}
		})
	}
}

// snapshotDir maps every file under dir to its content and mode.
func snapshotDir(t *testing.T, dir string) map[string]string {
	t.Helper()
	m := map[string]string{}
	err := filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return nil
		}
		os.Chmod(p, fi.Mode().Perm()|0o400) // read even the 0000 case
		b, rerr := os.ReadFile(p)
		os.Chmod(p, fi.Mode().Perm())
		if rerr != nil {
			return rerr
		}
		m[p] = fi.Mode().String() + "\n" + string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestInitSelfHealsDerivedFiles(t *testing.T) {
	o := opts(t)
	first := mustInit(t, o)
	for _, p := range []string{"caddy/root.crt", "public/root.crt", "public/root.cer"} {
		if err := os.Remove(filepath.Join(o.Dir, p)); err != nil {
			t.Fatal(err)
		}
	}
	second := mustInit(t, o)
	if !second.Root.Equal(first.Root) || !second.Intermediate.Equal(first.Intermediate) {
		t.Fatal("self-heal regenerated CA material")
	}
	for _, p := range []string{"caddy/root.crt", "public/root.crt"} {
		if !readCert(t, filepath.Join(o.Dir, p)).Equal(first.Root) {
			t.Errorf("%s not restored", p)
		}
	}
	der, err := os.ReadFile(filepath.Join(o.Dir, "public", "root.cer"))
	if err != nil || !bytes.Equal(der, first.Root.Raw) {
		t.Errorf("public/root.cer not restored: %v", err)
	}
}

func TestInitSelfHealsMissingIntermediate(t *testing.T) {
	o := opts(t)
	first := mustInit(t, o)
	if err := os.RemoveAll(filepath.Join(o.Dir, "caddy")); err != nil {
		t.Fatal(err)
	}
	second := mustInit(t, o)
	if !second.Root.Equal(first.Root) {
		t.Fatal("root regenerated while healing intermediate")
	}
	if err := second.Intermediate.CheckSignatureFrom(first.Root); err != nil {
		t.Fatalf("healed intermediate not signed by root: %v", err)
	}
	if !interKey(t, o.Dir).PublicKey.Equal(second.Intermediate.PublicKey) {
		t.Error("healed intermediate key/cert mismatch")
	}
}

func TestInitRootCertWithoutKeyFails(t *testing.T) {
	o := opts(t)
	mustInit(t, o)
	if err := os.Remove(filepath.Join(o.Dir, "root.key")); err != nil {
		t.Fatal(err)
	}
	if _, err := Init(o); err == nil {
		t.Fatal("Init succeeded with root.crt but no root.key")
	}
}

func TestFilePermissions(t *testing.T) {
	o := opts(t)
	mustInit(t, o)
	want := map[string]os.FileMode{
		".":                      0o700 | os.ModeDir,
		"root.key":               0o600,
		"root.crt":               0o644,
		"caddy":                  0o700 | os.ModeDir,
		"caddy/root.crt":         0o644,
		"caddy/intermediate.crt": 0o644,
		"caddy/intermediate.key": 0o600,
		"public":                 0o755 | os.ModeDir,
		"public/root.crt":        0o644,
		"public/root.cer":        0o644,
	}
	for p, m := range want {
		fi, err := os.Stat(filepath.Join(o.Dir, p))
		if err != nil {
			t.Errorf("%s: %v", p, err)
			continue
		}
		if fi.Mode() != m {
			t.Errorf("%s: mode %v, want %v", p, fi.Mode(), m)
		}
	}
	// No temp files or extra entries left behind; the root key never sits next to Caddy's files.
	for _, d := range []string{"caddy", "public"} {
		es, _ := os.ReadDir(filepath.Join(o.Dir, d))
		for _, e := range es {
			if _, ok := want[d+"/"+e.Name()]; !ok {
				t.Errorf("unexpected file %s/%s", d, e.Name())
			}
		}
	}
	es, _ := os.ReadDir(o.Dir)
	for _, e := range es {
		if _, ok := want[e.Name()]; !ok {
			t.Errorf("unexpected file %s", e.Name())
		}
	}
}

func TestFilePermissionsTightenedOnExistingDir(t *testing.T) {
	o := opts(t)
	if err := os.MkdirAll(o.Dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(o.Dir, 0o777); err != nil {
		t.Fatal(err)
	}
	mustInit(t, o)
	fi, _ := os.Stat(o.Dir)
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("pre-existing dir mode %v, want 0700", fi.Mode().Perm())
	}
}

func TestLabelTruncatedToCNLimit(t *testing.T) {
	o := opts(t)
	o.Label = strings.Repeat("Ä", 80)
	b := mustInit(t, o)
	for _, c := range []*x509.Certificate{b.Root, b.Intermediate} {
		cn := c.Subject.CommonName
		if n := utf8.RuneCountInString(cn); n > 64 {
			t.Errorf("CN %q has %d chars, want <= 64", cn, n)
		}
		if !strings.HasPrefix(cn, "ProjectAchilles ") || !strings.Contains(cn, " – Ä") {
			t.Errorf("CN %q lost its prefix", cn)
		}
	}
}

func TestEmptyLabelFallsBackToZone(t *testing.T) {
	o := opts(t)
	o.Label = ""
	b := mustInit(t, o)
	if want := "ProjectAchilles Root CA – " + zone; b.Root.Subject.CommonName != want {
		t.Errorf("CN = %q, want %q", b.Root.Subject.CommonName, want)
	}
}

// --- load, renew, export, fingerprints --------------------------------------

func TestLoad(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	l, err := Load(o.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if !l.Root.Equal(b.Root) || !l.Intermediate.Equal(b.Intermediate) || l.Dir != o.Dir {
		t.Error("Load returned different material")
	}
	if _, err := Load(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("Load of empty dir succeeded")
	}
}

func TestRenewNotDue(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	renewed, err := Renew(o.Dir, 180*24*time.Hour, fixedNow(t0.Add(24*time.Hour)))
	if err != nil || renewed {
		t.Fatalf("renewed=%v err=%v, want false/nil", renewed, err)
	}
	l, _ := Load(o.Dir)
	if l.Intermediate.SerialNumber.Cmp(b.Intermediate.SerialNumber) != 0 {
		t.Error("intermediate changed although not due")
	}
}

func TestRenewDue(t *testing.T) {
	o := opts(t)
	o.IncludeIP = true
	b := mustInit(t, o)
	now := b.Intermediate.NotAfter.Add(-100 * 24 * time.Hour)
	renewed, err := Renew(o.Dir, 180*24*time.Hour, fixedNow(now))
	if err != nil || !renewed {
		t.Fatalf("renewed=%v err=%v, want true/nil", renewed, err)
	}
	l, err := Load(o.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if l.Intermediate.SerialNumber.Cmp(b.Intermediate.SerialNumber) == 0 {
		t.Error("intermediate serial unchanged after renew")
	}
	if !l.Root.Equal(b.Root) {
		t.Error("root changed during renew")
	}
	in := l.Intermediate
	assertConstraints(t, in)
	if got := ipNets(in.PermittedIPRanges); !reflect.DeepEqual(got, []string{"10.0.5.20/32"}) {
		t.Errorf("renewed PermittedIPRanges = %v", got)
	}
	if in.MaxPathLen != 0 || !in.MaxPathLenZero {
		t.Error("renewed intermediate lost pathlen:0")
	}
	if in.Subject.CommonName != b.Intermediate.Subject.CommonName {
		t.Errorf("renewed CN = %q", in.Subject.CommonName)
	}
	if !within(in.NotAfter.Sub(now), now.AddDate(2, 0, 0).Sub(now), 24*time.Hour) {
		t.Errorf("renewed NotAfter = %v, want ~2y after %v", in.NotAfter, now)
	}
	k := interKey(t, o.Dir)
	if !k.PublicKey.Equal(in.PublicKey) {
		t.Fatal("renewed key/cert mismatch")
	}
	if k.PublicKey.Equal(b.Intermediate.PublicKey) {
		t.Error("renew reused the old intermediate key")
	}
	fi, _ := os.Stat(filepath.Join(o.Dir, "caddy", "intermediate.key"))
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("renewed key mode %v", fi.Mode().Perm())
	}
	if err := verifyLeaf(issueLeafAt(t, in, k, now, "achilles.corp.example.com"), l.Root, in, now); err != nil {
		t.Errorf("leaf from renewed intermediate rejected: %v", err)
	}
	if err := verifyLeaf(issueLeafAt(t, in, k, now, "login.microsoftonline.com"), l.Root, in, now); err == nil {
		t.Error("renewed intermediate signs out-of-zone names")
	}
	es, _ := os.ReadDir(filepath.Join(o.Dir, "caddy"))
	if len(es) != 3 {
		t.Errorf("caddy dir has %d entries after renew, want 3 (no temp files)", len(es))
	}
}

func issueLeafAt(t *testing.T, parent *x509.Certificate, key crypto.Signer, at time.Time, name string) *x509.Certificate {
	t.Helper()
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7),
		NotBefore:    at.Add(-time.Hour),
		NotAfter:     at.Add(24 * time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{name},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &k.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return c
}

func TestRenewClampsToRootExpiry(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	now := b.Root.NotAfter.AddDate(-1, 0, 0)
	renewed, err := Renew(o.Dir, 180*24*time.Hour, fixedNow(now))
	if err != nil || !renewed {
		t.Fatalf("renewed=%v err=%v", renewed, err)
	}
	l, _ := Load(o.Dir)
	if l.Intermediate.NotAfter.After(l.Root.NotAfter) {
		t.Errorf("intermediate NotAfter %v exceeds root %v", l.Intermediate.NotAfter, l.Root.NotAfter)
	}
}

func TestInitClampsIntermediateToRoot(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	if b.Intermediate.NotAfter.After(b.Root.NotAfter) {
		t.Error("intermediate outlives root")
	}
}

func TestRenewFailsWhenRootExpired(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	if _, err := Renew(o.Dir, 180*24*time.Hour, fixedNow(b.Root.NotAfter.Add(time.Hour))); err == nil {
		t.Error("Renew succeeded with an expired root")
	}
}

func TestRenewHealsMismatchedPair(t *testing.T) {
	o := opts(t)
	mustInit(t, o)
	// Simulate a crash between the two renames: key replaced, cert not.
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	if err := os.WriteFile(filepath.Join(o.Dir, "caddy", "intermediate.key"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	renewed, err := Renew(o.Dir, 180*24*time.Hour, fixedNow(t0.Add(time.Hour)))
	if err != nil || !renewed {
		t.Fatalf("renewed=%v err=%v, want a heal", renewed, err)
	}
	l, err := Load(o.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if !interKey(t, o.Dir).PublicKey.Equal(l.Intermediate.PublicKey) {
		t.Error("pair still mismatched")
	}
}

func TestExport(t *testing.T) {
	o := opts(t)
	b := mustInit(t, o)
	out := filepath.Join(t.TempDir(), "export")
	got, err := Export(o.Dir, out)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(b.Root) {
		t.Error("Export returned a different root")
	}
	if !readCert(t, filepath.Join(out, "root.crt")).Equal(b.Root) {
		t.Error("exported root.crt differs")
	}
	der, err := os.ReadFile(filepath.Join(out, "root.cer"))
	if err != nil || !bytes.Equal(der, b.Root.Raw) {
		t.Errorf("exported root.cer differs: %v", err)
	}
	es, _ := os.ReadDir(out)
	if len(es) != 2 {
		t.Errorf("export wrote %d files, want exactly root.crt and root.cer", len(es))
	}
	// A tampered public copy is refused rather than exported.
	if err := os.WriteFile(filepath.Join(o.Dir, "public", "root.cer"), []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Export(o.Dir, t.TempDir()); err == nil {
		t.Error("Export handed out a public root.cer that differs from root.crt")
	}
}

func TestFingerprintFormats(t *testing.T) {
	b := mustInit(t, opts(t))
	s256, s1 := Fingerprints(b.Root)
	if !regexp.MustCompile(`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`).MatchString(s256) {
		t.Errorf("sha256 %q not uppercase colon hex", s256)
	}
	if !regexp.MustCompile(`^[0-9A-F]{40}$`).MatchString(s1) {
		t.Errorf("sha1 %q not a Windows thumbprint", s1)
	}
	// Known-answer: fingerprints are over the DER encoding.
	c := &x509.Certificate{Raw: []byte("abc")}
	s256, s1 = Fingerprints(c)
	if s256 != "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD" {
		t.Errorf("sha256(abc) = %s", s256)
	}
	if s1 != "A9993E364706816ABA3E25717850C26C9CD0D89D" {
		t.Errorf("sha1(abc) = %s", s1)
	}
}

// Package ca manages the ProjectAchilles CA: a name-constrained root and a
// pathlen:0 intermediate that Caddy uses to issue the server's leaf.
//
// The root is pushed into the Trusted Root store of every endpoint in a fleet,
// so both CA certificates carry critical name constraints (one DNS zone, and
// either the LAN IP/32 or no IPs at all) and are restricted to serverAuth. A
// stolen CA key can then only mint TLS server certificates inside that zone.
//
// Layout under Dir (dir 0700, private keys 0600, certificates 0644):
//
//	root.key, root.crt                    host only, never mounted into Caddy
//	caddy/root.crt, caddy/intermediate.*  the only files Caddy sees (dir 0700)
//	public/root.crt (PEM), root.cer (DER) served over plain HTTP (dir 0755)
package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
)

const (
	rootKeyFile   = "root.key"
	rootCertFile  = "root.crt"
	caddyDir      = "caddy"
	interKeyFile  = "intermediate.key"
	interCertFile = "intermediate.crt"
	publicDir     = "public"
	publicPEMFile = "root.crt"
	publicDERFile = "root.cer"

	rootPrefix  = "ProjectAchilles Root CA – "
	interPrefix = "ProjectAchilles Intermediate CA – "
	maxCN       = 64 // X.509 ub-common-name, in characters

	clockSkew = time.Hour

	modeDir       os.FileMode = 0o700
	modePublicDir os.FileMode = 0o755
	modeKey       os.FileMode = 0o600
	modeCert      os.FileMode = 0o644
)

// ErrExists is returned by Init when a CA already exists for a different zone
// and Rotate is false.
var ErrExists = errors.New("a ProjectAchilles CA already exists for a different zone")

// Options configures Init.
type Options struct {
	Dir   string // CA directory, e.g. /etc/projectachilles/ca
	Zone  string // the only DNS zone the CA may issue for (covers subdomains)
	LANIP string // the server's LAN IP; constrained to /32 when IncludeIP
	Label string // org or hostname shown in the CA common names; defaults to Zone
	// IncludeIP permits exactly LANIP as an IP SAN. Without it every IP is
	// excluded, because an absent IP constraint leaves IP SANs unconstrained.
	IncludeIP bool
	Rotate    bool // replace an existing root and intermediate with new keys
	// RotateOnlyIfChanged limits Rotate to an existing root that is read
	// successfully and whose constraints (zone and IP policy) differ from
	// these options, so a re-run with Rotate set never replaces a root it
	// already rotated. An unreadable root is then an error, not a rotation.
	RotateOnlyIfChanged bool
	Now                 func() time.Time // defaults to time.Now
}

// Bundle is the CA's public material.
type Bundle struct {
	Root, Intermediate *x509.Certificate
	Dir                string
}

// constraints are the name and usage restrictions shared by root and intermediate.
type constraints struct {
	zone      string
	permitted []*net.IPNet
	excluded  []*net.IPNet
}

func allIPs() []*net.IPNet {
	return []*net.IPNet{
		{IP: net.IPv4zero.To4(), Mask: net.CIDRMask(0, 32)},
		{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
	}
}

func (o Options) constraints() (constraints, error) {
	zone, err := dnsclass.Normalize(o.Zone)
	if err != nil {
		return constraints{}, fmt.Errorf("invalid CA zone: %w", err)
	}
	c := constraints{zone: zone}
	if !o.IncludeIP {
		c.excluded = allIPs()
		return c, nil
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(o.LANIP))
	if err != nil || ip.Zone() != "" {
		return constraints{}, fmt.Errorf("including the LAN IP requires a single IP address, got %q", o.LANIP)
	}
	ip = ip.Unmap()
	c.permitted = []*net.IPNet{{IP: ip.AsSlice(), Mask: net.CIDRMask(ip.BitLen(), ip.BitLen())}}
	return c, nil
}

// constraintsOf recovers and sanity-checks the constraints of a CA certificate.
// It refuses certificates this package would not have produced, so renewal
// can never issue an unconstrained intermediate.
func constraintsOf(c *x509.Certificate) (constraints, error) {
	if !c.IsCA || !c.BasicConstraintsValid {
		return constraints{}, errors.New("certificate is not a CA")
	}
	if !c.PermittedDNSDomainsCritical || len(c.PermittedDNSDomains) != 1 || c.PermittedDNSDomains[0] == "" {
		return constraints{}, errors.New("certificate lacks a critical single-zone DNS name constraint")
	}
	if len(c.ExtKeyUsage) != 1 || c.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth || len(c.UnknownExtKeyUsage) != 0 {
		return constraints{}, errors.New("certificate is not restricted to serverAuth")
	}
	k := constraints{zone: c.PermittedDNSDomains[0], permitted: c.PermittedIPRanges, excluded: c.ExcludedIPRanges}
	switch {
	case len(k.permitted) == 1 && len(k.excluded) == 0:
		if ones, bits := k.permitted[0].Mask.Size(); ones != bits || bits == 0 {
			return constraints{}, errors.New("certificate permits an IP range wider than a single address")
		}
	case len(k.permitted) == 0 && sameNets(k.excluded, allIPs()):
	default:
		return constraints{}, errors.New("certificate does not constrain IP SANs")
	}
	return k, nil
}

func sameNets(a, b []*net.IPNet) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].String() != b[i].String() {
			return false
		}
	}
	return true
}

func (c constraints) equal(o constraints) bool {
	return c.zone == o.zone && sameNets(c.permitted, o.permitted) && sameNets(c.excluded, o.excluded)
}

func (c constraints) apply(t *x509.Certificate) {
	t.IsCA = true
	t.BasicConstraintsValid = true
	t.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	t.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	t.PermittedDNSDomainsCritical = true
	t.PermittedDNSDomains = []string{c.zone}
	t.PermittedIPRanges = c.permitted
	t.ExcludedIPRanges = c.excluded
}

// commonName joins prefix and label, truncating label so the result is at
// most maxCN characters.
func commonName(prefix, label string) string {
	label = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, strings.TrimSpace(label))
	budget := maxCN - len([]rune(prefix))
	if r := []rune(label); len(r) > budget {
		label = strings.TrimRightFunc(string(r[:budget]), unicode.IsSpace)
	}
	return prefix + label
}

// labelOf recovers the label from a root certificate's common name.
func labelOf(root *x509.Certificate, fallback string) string {
	if l, ok := strings.CutPrefix(root.Subject.CommonName, rootPrefix); ok && l != "" {
		return l
	}
	return fallback
}

func newKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// newSerial returns a random 128-bit positive serial number.
func newSerial() (*big.Int, error) {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	return n.SetBit(n, 127, 1), nil
}

// subjectKeyID is the SHA-1 of the subjectPublicKey bits (RFC 5280 4.2.1.2 method 1).
func subjectKeyID(pub *ecdsa.PublicKey) ([]byte, error) {
	ek, err := pub.ECDH()
	if err != nil {
		return nil, err
	}
	sum := sha1.Sum(ek.Bytes())
	return sum[:], nil
}

func sign(tmpl, parent *x509.Certificate, pub *ecdsa.PublicKey, signer *ecdsa.PrivateKey) (*x509.Certificate, error) {
	serial, err := newSerial()
	if err != nil {
		return nil, err
	}
	skid, err := subjectKeyID(pub)
	if err != nil {
		return nil, err
	}
	tmpl.SerialNumber = serial
	tmpl.SubjectKeyId = skid
	if parent == nil {
		parent = tmpl
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, signer)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}

func issueRoot(c constraints, label string, now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	key, err := newKey()
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		Subject:    pkix.Name{CommonName: commonName(rootPrefix, label), Organization: []string{"ProjectAchilles"}},
		NotBefore:  now.Add(-clockSkew),
		NotAfter:   now.AddDate(10, 0, 0),
		MaxPathLen: 1,
	}
	c.apply(tmpl)
	cert, err := sign(tmpl, nil, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("create root CA: %w", err)
	}
	return cert, key, nil
}

func issueIntermediate(root *x509.Certificate, rootKey *ecdsa.PrivateKey, c constraints, label string, now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	if !now.Before(root.NotAfter) {
		return nil, nil, fmt.Errorf("root CA expired on %s; re-run ca init --rotate", root.NotAfter.Format(time.DateOnly))
	}
	key, err := newKey()
	if err != nil {
		return nil, nil, err
	}
	notAfter := now.AddDate(2, 0, 0)
	if notAfter.After(root.NotAfter) {
		notAfter = root.NotAfter
	}
	tmpl := &x509.Certificate{
		Subject:        pkix.Name{CommonName: commonName(interPrefix, label), Organization: []string{"ProjectAchilles"}},
		NotBefore:      now.Add(-clockSkew),
		NotAfter:       notAfter,
		MaxPathLen:     0,
		MaxPathLenZero: true,
	}
	c.apply(tmpl)
	cert, err := sign(tmpl, root, &key.PublicKey, rootKey)
	if err != nil {
		return nil, nil, fmt.Errorf("create intermediate CA: %w", err)
	}
	return cert, key, nil
}

// Init creates the CA under o.Dir, or converges an existing one.
//
// With an existing root and Rotate false, the root is kept: if its zone equals
// o.Zone the bundle is returned unchanged (re-writing any missing derived files
// and re-issuing a missing or broken intermediate); otherwise ErrExists.
// Rotate replaces the root and intermediate with new keys.
func Init(o Options) (*Bundle, error) {
	if o.Dir == "" {
		return nil, errors.New("CA directory is required")
	}
	c, err := o.constraints()
	if err != nil {
		return nil, err
	}
	now := time.Now
	if o.Now != nil {
		now = o.Now
	}
	label := o.Label
	if strings.TrimSpace(label) == "" {
		label = c.zone
	}

	// root.crt is the commit point: it is written after its key and the
	// intermediate, and before anything is published. Without it, nothing
	// from an earlier attempt can have reached an endpoint.
	if _, err := os.Stat(filepath.Join(o.Dir, rootCertFile)); err == nil {
		keep := !o.Rotate
		if o.Rotate && o.RotateOnlyIfChanged {
			d, err := differs(o.Dir, c)
			if err != nil {
				return nil, err
			}
			keep = !d
		}
		if keep {
			return converge(o.Dir, c, label, now())
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	t := now()
	root, rootKey, err := issueRoot(c, label, t)
	if err != nil {
		return nil, err
	}
	inter, interKey, err := issueIntermediate(root, rootKey, c, label, t)
	if err != nil {
		return nil, err
	}
	if err := ensureDirs(o.Dir); err != nil {
		return nil, err
	}
	if err := writeIntermediate(o.Dir, inter, interKey); err != nil {
		return nil, err
	}
	keyPEM, err := encodeKey(rootKey)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(filepath.Join(o.Dir, rootKeyFile), keyPEM, modeKey); err != nil {
		return nil, err
	}
	if err := writeFileAtomic(filepath.Join(o.Dir, rootCertFile), encodeCert(root), modeCert); err != nil {
		return nil, err
	}
	if err := writePublished(o.Dir, root); err != nil {
		return nil, err
	}
	return &Bundle{Root: root, Intermediate: inter, Dir: o.Dir}, nil
}

// differs reports whether the existing root in dir carries constraints other
// than want. A root that can't be read or whose constraints can't be
// recovered is an error, never "different": rotating on a damaged read
// would silently replace a root the whole fleet trusts.
func differs(dir string, want constraints) (bool, error) {
	path := filepath.Join(dir, rootCertFile)
	root, err := readCertFile(path)
	if err != nil {
		return false, fmt.Errorf("cannot read the existing root CA %s (%w); refusing an automatic rotation; fix or remove it, or rotate explicitly with --rotate without --if-changed", path, err)
	}
	have, err := constraintsOf(root)
	if err != nil {
		return false, fmt.Errorf("existing root CA %s: %w; refusing an automatic rotation; rotate explicitly with --rotate without --if-changed", path, err)
	}
	return !have.equal(want), nil
}

// WouldRotate reports whether Init(o) would replace an existing root: there
// is one, Rotate is set and, with RotateOnlyIfChanged, its constraints differ.
func WouldRotate(o Options) (bool, error) {
	if !o.Rotate {
		return false, nil
	}
	if _, err := os.Stat(filepath.Join(o.Dir, rootCertFile)); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if !o.RotateOnlyIfChanged {
		return true, nil
	}
	c, err := o.constraints()
	if err != nil {
		return false, err
	}
	return differs(o.Dir, c)
}

// converge keeps an existing root and repairs everything derived from it.
func converge(dir string, want constraints, label string, now time.Time) (*Bundle, error) {
	root, rootKey, err := loadRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("existing CA in %s is unusable (%w); re-run with --rotate to replace it (every endpoint must re-trust)", dir, err)
	}
	have, _ := constraintsOf(root) // validated by loadRoot
	if have.zone != want.zone {
		return nil, fmt.Errorf("%w: the CA in %s is constrained to %q, not %q; re-run with --rotate to replace it (every endpoint must re-trust)",
			ErrExists, dir, have.zone, want.zone)
	}
	if err := ensureDirs(dir); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Join(dir, rootKeyFile), modeKey); err != nil {
		return nil, err
	}
	inter, _, err := loadIntermediate(dir, root, have)
	if err != nil {
		var key *ecdsa.PrivateKey
		if inter, key, err = issueIntermediate(root, rootKey, have, labelOf(root, label), now); err != nil {
			return nil, err
		}
		if err := writeIntermediate(dir, inter, key); err != nil {
			return nil, err
		}
	} else if err := os.Chmod(filepath.Join(dir, caddyDir, interKeyFile), modeKey); err != nil {
		return nil, err
	}
	if err := writePublished(dir, root); err != nil {
		return nil, err
	}
	return &Bundle{Root: root, Intermediate: inter, Dir: dir}, nil
}

// Load reads the root and intermediate certificates and checks that the
// intermediate chains to the root. It does not read private keys.
func Load(dir string) (*Bundle, error) {
	root, err := readCertFile(filepath.Join(dir, rootCertFile))
	if err != nil {
		return nil, err
	}
	inter, err := readCertFile(filepath.Join(dir, caddyDir, interCertFile))
	if err != nil {
		return nil, err
	}
	if err := inter.CheckSignatureFrom(root); err != nil {
		return nil, fmt.Errorf("intermediate is not signed by the root: %w", err)
	}
	return &Bundle{Root: root, Intermediate: inter, Dir: dir}, nil
}

// loadRoot reads the root certificate and key and checks they belong together
// and carry the expected constraints.
func loadRoot(dir string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	cert, err := readCertFile(filepath.Join(dir, rootCertFile))
	if err != nil {
		return nil, nil, err
	}
	key, err := readKeyFile(filepath.Join(dir, rootKeyFile))
	if err != nil {
		return nil, nil, err
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return nil, nil, errors.New("root.key does not match root.crt")
	}
	if err := cert.CheckSignatureFrom(cert); err != nil {
		return nil, nil, fmt.Errorf("root.crt is not a self-signed CA: %w", err)
	}
	if _, err := constraintsOf(cert); err != nil {
		return nil, nil, fmt.Errorf("root.crt: %w", err)
	}
	return cert, key, nil
}

// loadIntermediate returns the intermediate only if its key matches, it is
// signed by root, and it carries the root's constraints and pathlen:0.
func loadIntermediate(dir string, root *x509.Certificate, want constraints) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	cert, err := readCertFile(filepath.Join(dir, caddyDir, interCertFile))
	if err != nil {
		return nil, nil, err
	}
	key, err := readKeyFile(filepath.Join(dir, caddyDir, interKeyFile))
	if err != nil {
		return nil, nil, err
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return nil, nil, errors.New("intermediate key does not match certificate")
	}
	if err := cert.CheckSignatureFrom(root); err != nil {
		return nil, nil, fmt.Errorf("intermediate is not signed by the root: %w", err)
	}
	have, err := constraintsOf(cert)
	if err != nil {
		return nil, nil, err
	}
	if !have.equal(want) || cert.MaxPathLen != 0 || !cert.MaxPathLenZero {
		return nil, nil, errors.New("intermediate constraints differ from the root's")
	}
	return cert, key, nil
}

// --- encoding and files ------------------------------------------------------

func encodeCert(c *x509.Certificate) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})
}

func encodeKey(k *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func readCertFile(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	blk, rest := pem.Decode(data)
	if blk == nil || blk.Type != "CERTIFICATE" || strings.TrimSpace(string(rest)) != "" {
		return nil, fmt.Errorf("%s: expected exactly one PEM certificate", path)
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

func readKeyFile(path string) (*ecdsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(data)
	if blk == nil || blk.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s: expected a PKCS#8 PEM private key", path)
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	ek, ok := k.(*ecdsa.PrivateKey)
	if !ok || ek.Curve != elliptic.P256() {
		return nil, fmt.Errorf("%s: not an ECDSA P-256 key", path)
	}
	return ek, nil
}

// ensureDir creates path (parents 0755) and forces its mode, so a
// pre-existing directory with looser permissions is tightened.
func ensureDir(path string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.Mkdir(path, mode); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s exists and is not a directory", path)
	}
	return os.Chmod(path, mode)
}

func ensureDirs(dir string) error {
	if err := ensureDir(dir, modeDir); err != nil {
		return err
	}
	if err := ensureDir(filepath.Join(dir, caddyDir), modeDir); err != nil {
		return err
	}
	return ensureDir(filepath.Join(dir, publicDir), modePublicDir)
}

type fileSpec struct {
	path string
	data []byte
	mode os.FileMode
}

// writeFilesAtomic stages every file as a temp file in its target directory,
// then renames them into place in order. Readers never see a partially
// written file, and the window in which a pair is mismatched is only the gap
// between consecutive renames.
func writeFilesAtomic(files ...fileSpec) (err error) {
	tmps := make([]string, 0, len(files))
	defer func() {
		if err != nil {
			for _, t := range tmps {
				_ = os.Remove(t)
			}
		}
	}()
	for _, f := range files {
		tmp, err := stage(f)
		if err != nil {
			return err
		}
		tmps = append(tmps, tmp)
	}
	for i, f := range files {
		if err := os.Rename(tmps[i], f.path); err != nil {
			return err
		}
	}
	tmps = nil
	for _, f := range files {
		if err := syncDir(filepath.Dir(f.path)); err != nil {
			return err
		}
	}
	return nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	return writeFilesAtomic(fileSpec{path, data, mode})
}

// stage writes f to a temp file (created 0600, so a key is never briefly
// world-readable) and returns its path.
func stage(f fileSpec) (string, error) {
	t, err := os.CreateTemp(filepath.Dir(f.path), "."+filepath.Base(f.path)+".tmp-*")
	if err != nil {
		return "", err
	}
	name := t.Name()
	_, werr := t.Write(f.data)
	if werr == nil {
		werr = t.Chmod(f.mode)
	}
	if werr == nil {
		werr = t.Sync()
	}
	if cerr := t.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(name)
		return "", werr
	}
	return name, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// writeIfChanged rewrites path only when its content differs, and always
// enforces mode.
func writeIfChanged(path string, data []byte, mode os.FileMode) error {
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(data) {
		return os.Chmod(path, mode)
	}
	return writeFileAtomic(path, data, mode)
}

func writeIntermediate(dir string, cert *x509.Certificate, key *ecdsa.PrivateKey) error {
	keyPEM, err := encodeKey(key)
	if err != nil {
		return err
	}
	return writeFilesAtomic(
		fileSpec{filepath.Join(dir, caddyDir, interKeyFile), keyPEM, modeKey},
		fileSpec{filepath.Join(dir, caddyDir, interCertFile), encodeCert(cert), modeCert},
	)
}

// writePublished (re)writes the root copies for Caddy and for plain-HTTP download.
func writePublished(dir string, root *x509.Certificate) error {
	pemBytes := encodeCert(root)
	for _, f := range []fileSpec{
		{filepath.Join(dir, rootCertFile), pemBytes, modeCert},
		{filepath.Join(dir, caddyDir, rootCertFile), pemBytes, modeCert},
		{filepath.Join(dir, publicDir, publicPEMFile), pemBytes, modeCert},
		{filepath.Join(dir, publicDir, publicDERFile), root.Raw, modeCert},
	} {
		if err := writeIfChanged(f.path, f.data, f.mode); err != nil {
			return err
		}
	}
	return nil
}

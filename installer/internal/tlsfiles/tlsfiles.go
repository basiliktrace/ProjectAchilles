// Package tlsfiles generates the key + CSR for the Enterprise-CA option and
// validates certificate/key pairs for it and for bring-your-own certificates.
// It has no UI; the wizard's certificate screen calls it.
package tlsfiles

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// GenerateCSR creates an ECDSA P-256 key (PKCS#8 PEM) and a CSR (PEM) whose
// CN and only DNS SAN is host, plus ip as an IP SAN when ip is not empty.
func GenerateCSR(host, ip string) (keyPEM, csrPEM []byte, err error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, nil, errors.New("hostname is required for the certificate request")
	}
	tmpl := &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: host},
		DNSNames: []string{host},
	}
	if ip != "" {
		parsed := net.ParseIP(strings.Trim(ip, "[]"))
		if parsed == nil {
			return nil, nil, fmt.Errorf("invalid IP address %q", ip)
		}
		tmpl.IPAddresses = []net.IP{parsed}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		return nil, nil, err
	}
	k8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: k8}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// CSRMatches reports whether csrPEM is a validly signed request made with
// keyPEM for exactly host and (when not empty) ip.
func CSRMatches(keyPEM, csrPEM []byte, host, ip string) bool {
	key, err := ParseKey(keyPEM)
	if err != nil {
		return false
	}
	blk, _ := pem.Decode(csrPEM)
	if blk == nil || blk.Type != "CERTIFICATE REQUEST" {
		return false
	}
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		return false
	}
	if !samePublic(key.Public(), csr.PublicKey) {
		return false
	}
	if len(csr.DNSNames) != 1 || csr.DNSNames[0] != host {
		return false
	}
	if ip == "" {
		return len(csr.IPAddresses) == 0
	}
	want := net.ParseIP(strings.Trim(ip, "[]"))
	return len(csr.IPAddresses) == 1 && want != nil && csr.IPAddresses[0].Equal(want)
}

type publicKey interface{ Equal(crypto.PublicKey) bool }

func samePublic(a, b crypto.PublicKey) bool {
	pa, ok := a.(publicKey)
	return ok && pa.Equal(b)
}

// ParseKey reads the first private key in a PEM file: PKCS#8, SEC1 EC
// ("EC PRIVATE KEY") or PKCS#1 RSA. Other blocks (e.g. EC PARAMETERS) are
// skipped. Encrypted keys are rejected.
func ParseKey(data []byte) (crypto.Signer, error) {
	rest := data
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			return nil, errors.New("no private key found (expected a PEM \"PRIVATE KEY\" block)")
		}
		if !strings.HasSuffix(blk.Type, "PRIVATE KEY") {
			continue
		}
		if blk.Type == "ENCRYPTED PRIVATE KEY" || blk.Headers["Proc-Type"] != "" {
			return nil, errors.New("the private key is encrypted; provide it without a passphrase")
		}
		var k any
		var err error
		switch blk.Type {
		case "EC PRIVATE KEY":
			k, err = x509.ParseECPrivateKey(blk.Bytes)
		case "RSA PRIVATE KEY":
			k, err = x509.ParsePKCS1PrivateKey(blk.Bytes)
		default:
			k, err = x509.ParsePKCS8PrivateKey(blk.Bytes)
		}
		if err != nil {
			return nil, fmt.Errorf("could not parse the private key: %w", err)
		}
		switch s := k.(type) {
		case *ecdsa.PrivateKey:
			return s, nil
		case *rsa.PrivateKey:
			return s, nil
		case ed25519.PrivateKey:
			return s, nil
		default:
			return nil, fmt.Errorf("unsupported private key type %T", k)
		}
	}
}

func parseChain(data []byte) ([]*x509.Certificate, error) {
	var out []*x509.Certificate
	rest := data
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("certificate %d in the file could not be parsed: %w", len(out)+1, err)
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, errors.New("no certificate found (expected PEM \"BEGIN CERTIFICATE\" blocks)")
	}
	return out, nil
}

// ValidatePair checks a PEM chain and key: the first certificate is the
// server's own, matches the key, covers host (and ip when not empty), is
// valid at now and usable for server authentication, and each further
// certificate signed the one before it.
func ValidatePair(chainPEM, keyPEM []byte, host, ip string, now time.Time) error {
	chain, err := parseChain(chainPEM)
	if err != nil {
		return err
	}
	key, err := ParseKey(keyPEM)
	if err != nil {
		return err
	}
	leaf := chain[0]
	for i := 1; i < len(chain); i++ {
		if chain[i-1].CheckSignatureFrom(chain[i]) != nil {
			return fmt.Errorf("certificate %d in the chain did not sign certificate %d; put the server certificate first, then its intermediates", i+1, i)
		}
	}
	if !samePublic(key.Public(), leaf.PublicKey) {
		if leaf.IsCA && len(chain) > 1 {
			return errors.New("the first certificate is a CA certificate; put the server certificate first, then its intermediates")
		}
		return errors.New("the certificate does not match the private key")
	}
	if err := leaf.VerifyHostname(host); err != nil {
		return fmt.Errorf("the certificate is not valid for %s (it covers: %s)", host, covers(leaf))
	}
	if ip != "" {
		if err := leaf.VerifyHostname(strings.Trim(ip, "[]")); err != nil {
			return fmt.Errorf("the certificate is not valid for %s (it covers: %s)", ip, covers(leaf))
		}
	}
	switch {
	case now.After(leaf.NotAfter):
		return fmt.Errorf("the certificate expired on %s", leaf.NotAfter.UTC().Format(time.DateOnly))
	case now.Before(leaf.NotBefore):
		return fmt.Errorf("the certificate is not valid until %s", leaf.NotBefore.UTC().Format(time.DateOnly))
	}
	if len(leaf.ExtKeyUsage) > 0 && !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageServerAuth) &&
		!slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageAny) {
		return errors.New("the certificate is not for server authentication (its extended key usage lacks serverAuth)")
	}
	return nil
}

func covers(c *x509.Certificate) string {
	var names []string
	names = append(names, c.DNSNames...)
	for _, ip := range c.IPAddresses {
		names = append(names, ip.String())
	}
	if len(names) == 0 {
		return "no subject alternative names"
	}
	return strings.Join(names, ", ")
}

// LoadPair reads and validates certPath + keyPath (see ValidatePair).
func LoadPair(certPath, keyPath, host, ip string, now time.Time) (chainPEM, keyPEM []byte, err error) {
	if chainPEM, err = os.ReadFile(certPath); err != nil {
		return nil, nil, fmt.Errorf("could not read %s: %w", certPath, unwrapPath(err))
	}
	if keyPEM, err = os.ReadFile(keyPath); err != nil {
		return nil, nil, fmt.Errorf("could not read %s: %w", keyPath, unwrapPath(err))
	}
	if err := ValidatePair(chainPEM, keyPEM, host, ip, now); err != nil {
		return nil, nil, err
	}
	return chainPEM, keyPEM, nil
}

// unwrapPath drops the *PathError wrapper, whose path the caller already names.
func unwrapPath(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// WriteFile atomically writes data to path with mode, creating the parent
// directory (0755) if needed.
func WriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

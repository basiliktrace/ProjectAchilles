package ca

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Fingerprints returns the SHA-256 fingerprint of c's DER encoding as
// uppercase colon-separated hex, and the SHA-1 as an uppercase Windows
// thumbprint without separators.
func Fingerprints(c *x509.Certificate) (sha256Colon, sha1Thumbprint string) {
	s256 := sha256.Sum256(c.Raw)
	parts := make([]string, len(s256))
	for i, b := range s256 {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	s1 := sha1.Sum(c.Raw)
	return strings.Join(parts, ":"), fmt.Sprintf("%X", s1[:])
}

// Export copies the published root (public/root.crt PEM and public/root.cer
// DER) into out and returns the root. It checks both copies are the CA's
// current root first, so a stale or tampered public file is never handed out.
// No key is ever copied.
func Export(dir, out string) (*x509.Certificate, error) {
	root, err := readCertFile(filepath.Join(dir, rootCertFile))
	if err != nil {
		return nil, err
	}
	pub, err := readCertFile(filepath.Join(dir, publicDir, publicPEMFile))
	if err != nil {
		return nil, fmt.Errorf("%w (re-run ca init to restore it)", err)
	}
	der, err := os.ReadFile(filepath.Join(dir, publicDir, publicDERFile))
	if err != nil {
		return nil, fmt.Errorf("%w (re-run ca init to restore it)", err)
	}
	if !pub.Equal(root) || !bytes.Equal(der, root.Raw) {
		return nil, fmt.Errorf("published root in %s does not match root.crt; re-run ca init to repair it", filepath.Join(dir, publicDir))
	}
	// MkdirAll, not ensureDir: never change the mode of a directory the
	// operator chose that already exists.
	if err := os.MkdirAll(out, modePublicDir); err != nil {
		return nil, err
	}
	if err := writeFilesAtomic(
		fileSpec{filepath.Join(out, publicPEMFile), encodeCert(root), modeCert},
		fileSpec{filepath.Join(out, publicDERFile), root.Raw, modeCert},
	); err != nil {
		return nil, err
	}
	return root, nil
}

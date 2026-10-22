package ca

import (
	"errors"
	"fmt"
	"time"
)

// Renew re-issues the intermediate from the root key, with the root's
// constraints, when fewer than ifExpiring remain on it (or when it is missing
// or no longer matches its key or the root). It reports whether it did.
//
// The new key and certificate replace caddy/intermediate.{key,crt} via temp
// files and renames; the caller reloads Caddy afterwards. Leaves keep chaining
// to the same root, so endpoints are unaffected.
func Renew(dir string, ifExpiring time.Duration, now func() time.Time) (bool, error) {
	if ifExpiring < 0 {
		return false, errors.New("if-expiring must not be negative")
	}
	if now == nil {
		now = time.Now
	}
	t := now()
	root, rootKey, err := loadRoot(dir)
	if err != nil {
		return false, fmt.Errorf("load root CA from %s: %w", dir, err)
	}
	c, _ := constraintsOf(root) // validated by loadRoot
	if inter, _, err := loadIntermediate(dir, root, c); err == nil && inter.NotAfter.Sub(t) >= ifExpiring {
		return false, nil
	}
	inter, key, err := issueIntermediate(root, rootKey, c, labelOf(root, c.zone), t)
	if err != nil {
		return false, err
	}
	if err := ensureDirs(dir); err != nil {
		return false, err
	}
	if err := writeIntermediate(dir, inter, key); err != nil {
		return false, err
	}
	if err := writePublished(dir, root); err != nil {
		return false, err
	}
	return true, nil
}

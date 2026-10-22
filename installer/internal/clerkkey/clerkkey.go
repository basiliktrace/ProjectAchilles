// Package clerkkey decodes Clerk publishable keys offline and checks that the
// keys fit the server name and DNS situation chosen for the install.
package clerkkey

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
)

// Key is the decoded part of a publishable key that the installer cares about.
type Key struct {
	Live     bool
	FAPIHost string
}

// Finding is one problem (or caution) with the supplied keys. Messages are
// shown verbatim to the person running the installer.
type Finding struct {
	Severity string // "error" or "warn"
	Message  string
}

// DecodePublishable parses pk_live_/pk_test_ keys: base64 of "<host>$".
func DecodePublishable(pk string) (Key, error) {
	pk = strings.TrimSpace(pk)
	var k Key
	var body string
	switch {
	case strings.HasPrefix(pk, "pk_live_"):
		k.Live, body = true, strings.TrimPrefix(pk, "pk_live_")
	case strings.HasPrefix(pk, "pk_test_"):
		body = strings.TrimPrefix(pk, "pk_test_")
	default:
		return Key{}, errors.New("publishable key must start with pk_live_ or pk_test_")
	}
	body = strings.TrimRight(body, "=")
	raw, err := base64.RawStdEncoding.DecodeString(body)
	if err != nil {
		return Key{}, fmt.Errorf("publishable key is not valid base64: %w", err)
	}
	host, ok := strings.CutSuffix(string(raw), "$")
	if !ok {
		return Key{}, errors.New("publishable key payload is missing its trailing $")
	}
	if host == "" {
		return Key{}, errors.New("publishable key contains an empty Frontend API host")
	}
	k.FAPIHost = host
	return k, nil
}

// allowedFAPIHosts lists clerk.<D> for D = host and each parent down to and
// including the registrable domain (never above it).
func allowedFAPIHosts(r dnsclass.Result) []string {
	var out []string
	d := r.Host
	for {
		out = append(out, "clerk."+d)
		if d == r.Registrable {
			break
		}
		i := strings.IndexByte(d, '.')
		if i < 0 {
			break
		}
		d = d[i+1:]
		if !strings.HasSuffix(d, r.Registrable) && d != r.Registrable {
			break
		}
	}
	return out
}

// CheckFit validates the key pair against the chosen host and DNS class.
func CheckFit(pk, sk string, r dnsclass.Result) []Finding {
	pk, sk = strings.TrimSpace(pk), strings.TrimSpace(sk)
	var fs []Finding
	errf := func(f string, a ...any) { fs = append(fs, Finding{"error", fmt.Sprintf(f, a...)}) }
	warnf := func(f string, a ...any) { fs = append(fs, Finding{"warn", fmt.Sprintf(f, a...)}) }

	if pk == "" {
		errf("The Clerk publishable key is required (it starts with pk_live_ or pk_test_).")
	}
	if sk == "" {
		errf("The Clerk secret key is required (it starts with sk_live_ or sk_test_).")
	}

	var key Key
	pkOK := false
	if pk != "" {
		var err error
		if key, err = DecodePublishable(pk); err != nil {
			errf("The Clerk publishable key is not valid: %v.", err)
		} else {
			pkOK = true
		}
	}

	skLive, skOK := false, false
	if sk != "" {
		switch {
		case strings.HasPrefix(sk, "sk_live_"):
			skLive, skOK = true, true
		case strings.HasPrefix(sk, "sk_test_"):
			skOK = true
		default:
			errf("The Clerk secret key must start with sk_live_ or sk_test_.")
		}
	}

	if pkOK && skOK && key.Live != skLive {
		errf("The Clerk publishable and secret keys are from different environments (one is production, the other development). Copy both keys from the same Clerk instance.")
	}

	if pkOK {
		switch {
		case !key.Live && r.Kind == dnsclass.PublicDomain:
			warnf("This is a Clerk development key (pk_test_). It works, but production keys (pk_live_) are recommended for %s: development instances show a \"Development mode\" banner and have stricter usage limits.", r.Host)
		case key.Live && r.Kind == dnsclass.PrivateOnly:
			errf("Production Clerk keys (pk_live_) need a public domain that you own, and %s is not under one. Either use a server name under a domain you own (for example achilles.<your-domain>) and create a production Clerk app for it, or use Clerk development keys (pk_test_).", r.Host)
		case key.Live:
			allowed := allowedFAPIHosts(r)
			ok := false
			for _, a := range allowed {
				if strings.EqualFold(a, key.FAPIHost) {
					ok = true
				}
			}
			if !ok {
				errf("This production key belongs to %s, but the server name %s needs a Clerk app on one of: %s.", key.FAPIHost, r.Host, strings.Join(allowed, ", "))
			}
		}
	}
	return fs
}

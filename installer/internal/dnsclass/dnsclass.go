// Package dnsclass normalises the customer's internal hostname and decides
// whether it sits under a public domain they can own (Clerk production keys,
// DNS-01 possible) or a private-only zone, and which parent zones a CA name
// constraint can be scoped to.
package dnsclass

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

// lookupTimeout bounds each individual DNS lookup.
const lookupTimeout = 3 * time.Second

// Kind is the DNS situation of a hostname.
type Kind int

const (
	// PrivateOnly means the name is not under a public domain we can confirm.
	PrivateOnly Kind = iota
	// PublicDomain means the registrable domain has public NS records.
	PublicDomain
)

func (k Kind) String() string {
	if k == PublicDomain {
		return "public-domain"
	}
	return "private-only"
}

// Result is the outcome of Classify.
type Result struct {
	Host           string
	Registrable    string
	Kind           Kind
	ZoneCandidates []string // parents of Host, nearest first, ending at Registrable
	Warnings       []string
	Reason         string
}

// Resolver is the subset of *net.Resolver used here.
type Resolver interface {
	LookupNS(ctx context.Context, name string) ([]*net.NS, error)
	LookupHost(ctx context.Context, host string) ([]string, error)
}

var _ Resolver = net.DefaultResolver

// privateTLDs are never public, regardless of the public suffix list.
var privateTLDs = []string{"local", "lan", "internal", "home.arpa", "corp", "intranet", "localdomain"}

// Normalize trims, lowercases and strips one trailing dot, then validates the
// name as a multi-label RFC 1123 hostname.
func Normalize(raw string) (string, error) {
	h := strings.ToLower(strings.TrimSpace(raw))
	h = strings.TrimSuffix(h, ".")
	if h == "" {
		return "", errors.New("hostname is empty")
	}
	if _, err := netip.ParseAddr(h); err == nil {
		return "", fmt.Errorf("%q is an IP address; a hostname is required", h)
	}
	if len(h) > 253 {
		return "", errors.New("hostname exceeds 253 characters")
	}
	labels := strings.Split(h, ".")
	if len(labels) < 2 {
		return "", fmt.Errorf("%q is a single label; a fully qualified name such as achilles.example.com is required", h)
	}
	for _, l := range labels {
		if err := validLabel(l); err != nil {
			return "", fmt.Errorf("invalid hostname %q: %w", h, err)
		}
	}
	if ps, _ := publicsuffix.PublicSuffix(h); ps == h {
		return "", fmt.Errorf("%q is a public suffix, not a host; use a name under it such as achilles.%s", h, h)
	}
	for _, t := range privateTLDs {
		if h == t {
			return "", fmt.Errorf("%q is a reserved top-level domain, not a host; use a name under it such as achilles.%s", h, h)
		}
	}
	return h, nil
}

func validLabel(l string) error {
	if l == "" {
		return errors.New("empty label")
	}
	if len(l) > 63 {
		return fmt.Errorf("label %q exceeds 63 characters", l)
	}
	if l[0] == '-' || l[len(l)-1] == '-' {
		return fmt.Errorf("label %q starts or ends with a hyphen", l)
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return fmt.Errorf("label %q contains invalid character %q", l, c)
		}
	}
	return nil
}

func hasSuffixLabel(host, suffix string) bool {
	return host == suffix || strings.HasSuffix(host, "."+suffix)
}

// isPrivateTLD reports whether the name is under a reserved/non-ICANN TLD.
func isPrivateTLD(host string) bool {
	for _, t := range privateTLDs {
		if hasSuffixLabel(host, t) {
			return true
		}
	}
	// PublicSuffix reports icann=false both for unknown TLDs and for entries in
	// the PSL private section (e.g. github.io). Only the former, which has no
	// dot in the matched suffix, is "not an ICANN TLD".
	ps, icann := publicsuffix.PublicSuffix(host)
	return !icann && !strings.Contains(ps, ".")
}

// privateRegistrable returns the TLD plus one label. For a multi-label special
// TLD such as home.arpa that is three labels, so the TLD is never a candidate.
func privateRegistrable(host string) string {
	n := 2
	for _, t := range privateTLDs {
		if hasSuffixLabel(host, t) {
			if m := strings.Count(t, ".") + 2; m > n {
				n = m
			}
		}
	}
	l := strings.Split(host, ".")
	if n > len(l) {
		n = len(l)
	}
	return strings.Join(l[len(l)-n:], ".")
}

// zoneCandidates lists the parents of host from nearest down to registrable.
// It never includes a bare TLD and is never empty for a valid FQDN.
func zoneCandidates(host, registrable string) []string {
	var out []string
	rest := host
	for {
		i := strings.IndexByte(rest, '.')
		if i < 0 {
			break
		}
		rest = rest[i+1:]
		if !hasSuffixLabel(rest, registrable) {
			break
		}
		out = append(out, rest)
		if rest == registrable {
			break
		}
	}
	if len(out) == 0 {
		out = []string{host}
	}
	return out
}

// Classify normalises host and determines its DNS situation. It never returns
// an error: problems are reported through Kind, Warnings and Reason.
func Classify(ctx context.Context, host string, r Resolver) Result {
	h, err := Normalize(host)
	if err != nil {
		return Result{Host: strings.TrimSpace(host), Kind: PrivateOnly, Reason: err.Error()}
	}
	res := Result{Host: h}

	if isPrivateTLD(h) {
		res.Registrable = privateRegistrable(h)
		res.Kind = PrivateOnly
		res.ZoneCandidates = zoneCandidates(h, res.Registrable)
		res.Reason = "the name is under a private/reserved top-level domain that cannot be publicly registered"
		if hasSuffixLabel(h, "local") {
			res.Warnings = append(res.Warnings,
				".local names are reserved for mDNS; some clients resolve them via multicast instead of your DNS server, which can break browsers and agents. Prefer .lan or a subdomain of a domain you own")
		}
		return res
	}

	reg, err := publicsuffix.EffectiveTLDPlusOne(h)
	if err != nil {
		reg = h // host is itself a public suffix
	}
	res.Registrable = reg
	res.ZoneCandidates = zoneCandidates(h, reg)

	lctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	ns, err := r.LookupNS(lctx, reg)
	var dnsErr *net.DNSError
	switch {
	case err == nil && len(ns) > 0:
		res.Kind = PublicDomain
		res.Reason = fmt.Sprintf("%s has public name servers", reg)
	case err == nil || (errors.As(err, &dnsErr) && dnsErr.IsNotFound):
		res.Kind = PrivateOnly
		res.Reason = fmt.Sprintf("%s does not exist in public DNS", reg)
	default:
		res.Kind = PrivateOnly
		res.Reason = fmt.Sprintf("public DNS lookup for %s failed: %v", reg, err)
		res.Warnings = append(res.Warnings,
			fmt.Sprintf("could not reach public DNS to check %s; treating the name as private-only", reg))
	}
	return res
}

func isNotFound(err error) bool {
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr) && dnsErr.IsNotFound
}

// ResolvesTo reports whether host resolves to ip. It also returns the
// addresses seen. NXDOMAIN yields (false, nil, nil); other failures return an
// error.
func ResolvesTo(ctx context.Context, host, ip string, r Resolver) (bool, []string, error) {
	lctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	addrs, err := r.LookupHost(lctx, host)
	if err != nil {
		if isNotFound(err) {
			return false, nil, nil
		}
		return false, nil, err
	}
	want, perr := netip.ParseAddr(ip)
	for _, a := range addrs {
		if perr == nil {
			if got, e := netip.ParseAddr(a); e == nil && got.Unmap() == want.Unmap() {
				return true, addrs, nil
			}
		} else if a == ip {
			return true, addrs, nil
		}
	}
	return false, addrs, nil
}

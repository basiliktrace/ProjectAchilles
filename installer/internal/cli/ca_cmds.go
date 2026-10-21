package cli

import (
	"context"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/projectachilles/ProjectAchilles/installer/internal/ca"
)

// defaultCADir is where the engine and the renewal timer expect the CA.
const defaultCADir = "/etc/projectachilles/ca"

func init() { registerCA(defaultRegistry, os.Stdout, os.Stderr) }

// registerCA binds the "ca init|renew|export" handlers on r.
func registerCA(r *Registry, stdout, stderr io.Writer) {
	r.Register("ca init", caInit(stdout, stderr))
	r.Register("ca renew", caRenew(stdout, stderr))
	r.Register("ca export", caExport(stdout, stderr))
}

// parseFlags parses args and rejects positional leftovers. A help request
// returns flag.ErrHelp; handlers map it to success via helpOK.
func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return nil
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

func helpOK(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	return err
}

// parseExpiry accepts Go durations ("36h") and whole or fractional days ("180d").
func parseExpiry(s string) (time.Duration, error) {
	var d time.Duration
	if num, ok := strings.CutSuffix(s, "d"); ok {
		days, err := strconv.ParseFloat(num, 64)
		if err != nil || math.IsNaN(days) || math.IsInf(days, 0) {
			return 0, fmt.Errorf("invalid duration %q", s)
		}
		h := days * 24 * float64(time.Hour)
		if h > math.MaxInt64 || h < math.MinInt64 {
			return 0, fmt.Errorf("duration %q out of range", s)
		}
		d = time.Duration(h)
	} else {
		var err error
		if d, err = time.ParseDuration(s); err != nil {
			return 0, fmt.Errorf("invalid duration %q (use e.g. 180d or 72h)", s)
		}
	}
	if d < 0 {
		return 0, fmt.Errorf("duration %q must not be negative", s)
	}
	return d, nil
}

func printFingerprints(w io.Writer, root *x509.Certificate) {
	s256, s1 := ca.Fingerprints(root)
	fmt.Fprintf(w, "SHA-256: %s\n", s256)
	fmt.Fprintf(w, "SHA-1 thumbprint: %s\n", s1)
}

func caInit(stdout, stderr io.Writer) Handler {
	return func(_ context.Context, args []string) error {
		fs := newFlagSet("ca init", stderr)
		dir := fs.String("dir", defaultCADir, "CA directory")
		zone := fs.String("zone", "", "DNS zone the CA may issue for, e.g. corp.example.com (required)")
		ip := fs.String("ip", "", "server LAN IP")
		includeIP := fs.Bool("include-ip", false, "also permit --ip (as /32) in IP SANs; otherwise every IP is excluded")
		label := fs.String("label", "", "org or hostname shown in the CA names (default: the zone)")
		rotate := fs.Bool("rotate", false, "replace an existing CA with new keys (every endpoint must re-trust)")
		if err := parseFlags(fs, args); err != nil {
			return helpOK(err)
		}
		if *zone == "" {
			return errors.New("--zone is required")
		}
		if *includeIP && *ip == "" {
			return errors.New("--include-ip requires --ip")
		}
		if *rotate {
			fmt.Fprintln(stderr, "WARNING: --rotate replaces the root CA. Every endpoint (and any GPO) must re-trust the new root.")
		}
		b, err := ca.Init(ca.Options{Dir: *dir, Zone: *zone, LANIP: *ip, Label: *label, IncludeIP: *includeIP, Rotate: *rotate})
		if err != nil {
			return err
		}
		ipDesc := "none (every IP SAN is excluded)"
		if n := b.Root.PermittedIPRanges; len(n) > 0 {
			ipDesc = n[0].IP.String() + " only"
		} else if *ip != "" {
			ipDesc += "; pass --include-ip to permit " + *ip
		}
		fmt.Fprintf(stdout, "ProjectAchilles CA ready in %s\n", b.Dir)
		fmt.Fprintf(stdout, "  Root:          %s (expires %s)\n", b.Root.Subject.CommonName, b.Root.NotAfter.Format(time.DateOnly))
		fmt.Fprintf(stdout, "  Intermediate:  %s (expires %s)\n", b.Intermediate.Subject.CommonName, b.Intermediate.NotAfter.Format(time.DateOnly))
		fmt.Fprintf(stdout, "  DNS names:     %s and its subdomains only\n", b.Root.PermittedDNSDomains[0])
		fmt.Fprintf(stdout, "  IP addresses:  %s\n", ipDesc)
		fmt.Fprintf(stdout, "  Root cert:     %s (PEM), %s (DER, for Windows/GPO)\n",
			filepath.Join(b.Dir, "public", "root.crt"), filepath.Join(b.Dir, "public", "root.cer"))
		printFingerprints(stdout, b.Root)
		return nil
	}
}

func caRenew(stdout, stderr io.Writer) Handler {
	return func(_ context.Context, args []string) error {
		fs := newFlagSet("ca renew", stderr)
		dir := fs.String("dir", defaultCADir, "CA directory")
		within := fs.String("if-expiring", "180d", "renew when less than this remains on the intermediate (e.g. 180d, 72h)")
		if err := parseFlags(fs, args); err != nil {
			return helpOK(err)
		}
		d, err := parseExpiry(*within)
		if err != nil {
			return fmt.Errorf("--if-expiring: %w", err)
		}
		renewed, err := ca.Renew(*dir, d, time.Now)
		if err != nil {
			return err
		}
		if renewed {
			fmt.Fprintln(stdout, "renewed")
		} else {
			fmt.Fprintln(stdout, "not due")
		}
		return nil
	}
}

func caExport(stdout, stderr io.Writer) Handler {
	return func(_ context.Context, args []string) error {
		fs := newFlagSet("ca export", stderr)
		dir := fs.String("dir", defaultCADir, "CA directory")
		out := fs.String("out", "", "directory to write root.crt and root.cer into (required)")
		if err := parseFlags(fs, args); err != nil {
			return helpOK(err)
		}
		if *out == "" {
			return errors.New("--out is required")
		}
		root, err := ca.Export(*dir, *out)
		if err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Wrote %s and %s\n", filepath.Join(*out, "root.crt"), filepath.Join(*out, "root.cer"))
		printFingerprints(stdout, root)
		return nil
	}
}

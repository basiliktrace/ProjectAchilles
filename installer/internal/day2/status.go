package day2

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/ca"
)

// Level is how a status check is graded.
type Level int

// Check levels. Info rows never affect the exit status.
const (
	Info Level = iota
	OK
	Warn
	Fail
)

const (
	interWarnWithin = 90 * 24 * time.Hour
	rootWarnWithin  = 365 * 24 * time.Hour
)

// Check is one row of the status report.
type Check struct {
	Name  string
	Value string
	Level Level
}

// Report is the result of Status.
type Report struct{ Checks []Check }

// OK reports whether nothing warns or fails.
func (r Report) OK() bool {
	for _, c := range r.Checks {
		if c.Level >= Warn {
			return false
		}
	}
	return true
}

func (r Report) find(name string) *Check {
	for i := range r.Checks {
		if r.Checks[i].Name == name {
			return &r.Checks[i]
		}
	}
	return nil
}

func (r *Report) add(name string, l Level, format string, a ...any) {
	r.Checks = append(r.Checks, Check{Name: name, Level: l, Value: fmt.Sprintf(format, a...)})
}

// Render writes the report as a table; color adds Lip Gloss styling for a TTY.
func (r Report) Render(w io.Writer, color bool) {
	width := 0
	for _, c := range r.Checks {
		width = max(width, len(c.Name))
	}
	for _, c := range r.Checks {
		mark := map[Level]string{Info: "  ", OK: "ok", Warn: "!!", Fail: "xx"}[c.Level]
		if color {
			col := map[Level]string{Info: "8", OK: "2", Warn: "3", Fail: "1"}[c.Level]
			mark = lipgloss.NewStyle().Foreground(lipgloss.Color(col)).Bold(true).Render(mark)
		}
		fmt.Fprintf(w, " %s  %-*s  %s\n", mark, width, c.Name, c.Value)
	}
	if r.OK() {
		fmt.Fprintln(w, "\nAll checks passed.")
	} else {
		fmt.Fprintln(w, "\nSome checks need attention (marked !! or xx).")
	}
}

// HealthResult is the answer from GET https://<host>/api/health.
type HealthResult struct {
	Status int
	Leaf   *x509.Certificate // the certificate the server presented
}

// DefaultHealth does the real request, verifying the server against roots
// (nil means the system pool).
func DefaultHealth(ctx context.Context, host string, roots *x509.CertPool) (HealthResult, error) {
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	cl := &http.Client{Transport: tr, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+"/api/health", nil)
	if err != nil {
		return HealthResult{}, err
	}
	resp, err := cl.Do(req)
	if err != nil {
		return HealthResult{}, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	res := HealthResult{Status: resp.StatusCode}
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		res.Leaf = resp.TLS.PeerCertificates[0]
	}
	return res, nil
}

// composeService is the subset of `docker compose ps --format json` we read.
type composeService struct {
	Service string `json:"Service"`
	Name    string `json:"Name"`
	State   string `json:"State"`
	Health  string `json:"Health"`
}

// parsePS accepts both shapes compose has used: a JSON array, or one JSON
// object per line.
func parsePS(b []byte) ([]composeService, error) {
	b = []byte(strings.TrimSpace(string(b)))
	if len(b) == 0 {
		return nil, nil
	}
	if b[0] == '[' {
		var out []composeService
		return out, json.Unmarshal(b, &out)
	}
	var out []composeService
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var s composeService
		if err := json.Unmarshal([]byte(line), &s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// Status gathers the report. Each section degrades on its own: a missing
// docker daemon does not hide the CA, and vice versa. The error is reserved
// for programming faults; problems are rows in the report.
func Status(ctx context.Context, d Deps) (Report, error) {
	var r Report
	now := d.now()

	// Containers.
	if out, err := d.compose(ctx, "ps", "--format", "json"); err != nil {
		r.add("Containers", Fail, "unavailable (%s)", firstLine(err.Error()))
	} else if svcs, perr := parsePS(out); perr != nil {
		r.add("Containers", Fail, "unavailable (could not read docker compose ps: %v)", perr)
	} else if len(svcs) == 0 {
		r.add("Containers", Fail, "none running")
	} else {
		sort.Slice(svcs, func(i, j int) bool { return svcs[i].Service < svcs[j].Service })
		for _, s := range svcs {
			name := s.Service
			if name == "" {
				name = s.Name
			}
			lvl, v := OK, s.State
			switch {
			case s.State != "running":
				lvl = Fail
			case s.Health == "unhealthy":
				lvl, v = Fail, "running (unhealthy)"
			case s.Health == "starting":
				lvl, v = Warn, "running (health starting)"
			case s.Health != "":
				v = "running (" + s.Health + ")"
			}
			r.add("Container "+name, lvl, "%s", v)
		}
	}

	// CA (shown even when docker is down).
	var bundle *ca.Bundle
	if d.CADir != "" {
		_, statErr := os.Stat(d.CADir)
		switch {
		case statErr == nil || d.TLSMode == "achilles-ca":
			b, err := ca.Load(d.CADir)
			if err != nil {
				r.add("CA", Fail, "unavailable (%v)", err)
			} else {
				bundle = b
			}
		}
	}

	// Health, with the right trust roots for the TLS mode.
	var leaf *x509.Certificate
	if d.Host == "" {
		r.add("Health", Fail, "unreachable (no AchillesDomain in deploy.config.env)")
	} else {
		health := d.Health
		if health == nil {
			health = DefaultHealth
		}
		res, err := health(ctx, d.Host, d.trustRoots(bundle))
		switch {
		case err != nil:
			r.add("Health", Fail, "unreachable: https://%s/api/health (%s)", d.Host, firstLine(err.Error()))
		case res.Status != http.StatusOK:
			r.add("Health", Fail, "https://%s/api/health returned HTTP %d", d.Host, res.Status)
			leaf = res.Leaf
		default:
			r.add("Health", OK, "https://%s/api/health returned HTTP 200", d.Host)
			leaf = res.Leaf
		}
	}
	if leaf != nil {
		r.add("Server certificate", Info, "issued by %s, expires %s", leaf.Issuer.CommonName, leaf.NotAfter.Format(time.DateOnly))
	}

	if bundle != nil {
		in := bundle.Intermediate
		left := in.NotAfter.Sub(now)
		switch {
		case left <= 0:
			r.add("Intermediate CA", Fail, "EXPIRED on %s: run achilles-installer ca renew", in.NotAfter.Format(time.DateOnly))
		case left < interWarnWithin:
			r.add("Intermediate CA", Warn, "expires %s (%d days left): run achilles-installer ca renew", in.NotAfter.Format(time.DateOnly), int(left.Hours()/24))
		default:
			r.add("Intermediate CA", OK, "expires %s (%d days left)", in.NotAfter.Format(time.DateOnly), int(left.Hours()/24))
		}
		rl := bundle.Root.NotAfter.Sub(now)
		s256, _ := ca.Fingerprints(bundle.Root)
		switch {
		case rl <= 0:
			r.add("Root CA", Fail, "EXPIRED on %s; SHA-256 %s", bundle.Root.NotAfter.Format(time.DateOnly), s256)
		case rl < rootWarnWithin:
			r.add("Root CA", Warn, "expires %s (%d days left): plan a root rotation and re-trust on every endpoint; SHA-256 %s",
				bundle.Root.NotAfter.Format(time.DateOnly), int(rl.Hours()/24), s256)
		default:
			r.add("Root CA", OK, "expires %s; SHA-256 %s", bundle.Root.NotAfter.Format(time.DateOnly), s256)
		}
	}

	// Disk.
	df := d.DiskFree
	if df == nil {
		df = diskFree
	}
	if free, err := df(d.RepoDir); err != nil {
		r.add("Disk free", Info, "unavailable (%v)", err)
	} else {
		r.add("Disk free", Info, "%.1f GiB on %s", float64(free)/(1<<30), d.RepoDir)
	}

	// Last backup.
	if name, mod := lastBackup(d.backupDir("")); name == "" {
		r.add("Last backup", Info, "none in %s", d.backupDir(""))
	} else {
		r.add("Last backup", Info, "%s (%s)", name, mod.Format(time.DateTime))
	}
	return r, nil
}

// trustRoots is the pool that must verify the server: the ProjectAchilles
// root in achilles-ca mode, Caddy's exported root in internal mode, else the
// system pool (nil).
func (d Deps) trustRoots(b *ca.Bundle) *x509.CertPool {
	switch d.TLSMode {
	case "achilles-ca":
		if b != nil {
			p := x509.NewCertPool()
			p.AddCert(b.Root)
			return p
		}
	case "internal":
		if pem, err := os.ReadFile(filepath.Join(d.RepoDir, "deploy", "caddy", "certs", "root-ca.crt")); err == nil {
			p := x509.NewCertPool()
			if p.AppendCertsFromPEM(pem) {
				return p
			}
		}
	}
	return nil
}

func lastBackup(dir string) (string, time.Time) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return "", time.Time{}
	}
	var best string
	var bt time.Time
	for _, e := range ents {
		if e.IsDir() || !strings.Contains(e.Name(), ".tar.") {
			continue
		}
		if fi, err := e.Info(); err == nil && (best == "" || fi.ModTime().After(bt)) {
			best, bt = e.Name(), fi.ModTime()
		}
	}
	return best, bt
}

// firstLine is the first line of s, cut to a length a table row can hold.
func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if r := []rune(s); len(r) > 100 {
		s = string(r[:100]) + "..."
	}
	return s
}

var errCancelled = errors.New("cancelled; nothing was changed")

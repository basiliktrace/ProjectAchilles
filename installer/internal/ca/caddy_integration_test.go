//go:build integration

// Integration test: the real deploy/caddy config in TLS_MODE=achilles-ca,
// run in the pinned Caddy image against a CA made by Init.
//
//	cd installer && go test -count=1 -tags integration ./internal/ca/ -run Caddy -v
//
// Keep -count=1: the config under test (deploy/caddy) is outside this Go
// module, so the test cache does not notice when it changes.
//
// It skips when Docker is unavailable. It needs no root: the container gets
// random loopback ports and is removed afterwards.
package ca

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const (
	caddyImage  = "caddy:2.10.0-alpine" // keep in step with docker-compose.server.yml
	caddyDomain = "achilles." + zone
)

// upstreamBlock is the production upstream in deploy/caddy/Caddyfile. The test
// swaps it for a static response so no frontend container is needed.
var upstreamBlock = regexp.MustCompile(`(?s)\n\treverse_proxy frontend:80 \{.*?\n\t\}\n`)

func dockerCmd(ctx context.Context, args ...string) (string, error) {
	var out, errb bytes.Buffer
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("docker %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func requireDocker(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := dockerCmd(ctx, "info", "--format", "{{.ServerVersion}}"); err != nil {
		t.Skipf("docker daemon unavailable: %v", err)
	}
}

func repoCaddyDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "deploy", "caddy"))
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read %s: %v", src, err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// renderAchillesCA lays out what scripts/deploy-server.sh renders for
// TLS_MODE=achilles-ca: the Caddyfile (with the test upstream) and rendered/.
func renderAchillesCA(t *testing.T, work string) (caddyfile, rendered string) {
	t.Helper()
	src := repoCaddyDir(t)
	rendered = filepath.Join(work, "rendered")
	if err := os.MkdirAll(rendered, 0o755); err != nil {
		t.Fatal(err)
	}
	copyFile(t, filepath.Join(src, "tls-modes", "achilles-ca.caddy"), filepath.Join(rendered, "tls.caddy"))
	copyFile(t, filepath.Join(src, "extras", "achilles-ca.global.caddy"), filepath.Join(rendered, "global.caddy"))
	copyFile(t, filepath.Join(src, "extras", "achilles-ca.sites.caddy"), filepath.Join(rendered, "sites-extra.caddy"))

	cf, err := os.ReadFile(filepath.Join(src, "Caddyfile"))
	if err != nil {
		t.Fatal(err)
	}
	for _, imp := range []string{"/etc/caddy/rendered/global*.caddy", "/etc/caddy/rendered/tls*.caddy", "/etc/caddy/rendered/sites-extra*.caddy"} {
		if !bytes.Contains(cf, []byte("import "+imp)) {
			t.Fatalf("Caddyfile does not import %s", imp)
		}
	}
	if !upstreamBlock.Match(cf) {
		t.Fatal("Caddyfile upstream block not found; update upstreamBlock")
	}
	cf = upstreamBlock.ReplaceAll(cf, []byte("\n\trespond \"ok\"\n"))
	caddyfile = filepath.Join(work, "Caddyfile")
	if err := os.WriteFile(caddyfile, cf, 0o644); err != nil {
		t.Fatal(err)
	}
	return caddyfile, rendered
}

// composeHealthcheck is the caddy service's CMD-SHELL healthcheck from
// docker-compose.server.yml, so the container below runs the real one.
var composeHealthcheck = regexp.MustCompile(`(?s)\n  caddy:\n.*?\n    healthcheck:\n.*?\n      test: \["CMD-SHELL", "([^"]+)"\]`)

func caddyHealthcheck(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoCaddyDir(t), "..", "..", "docker-compose.server.yml"))
	if err != nil {
		t.Fatal(err)
	}
	m := composeHealthcheck.FindSubmatch(b)
	if m == nil {
		t.Fatal("caddy CMD-SHELL healthcheck not found in docker-compose.server.yml; update composeHealthcheck")
	}
	return string(m[1])
}

func hostPort(t *testing.T, ctx context.Context, name, port string) string {
	t.Helper()
	out, err := dockerCmd(ctx, "port", name, port)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.HasPrefix(line, "127.0.0.1:") {
			return strings.TrimSpace(line)
		}
	}
	t.Fatalf("no loopback mapping for %s: %q", port, out)
	return ""
}

// dialUntil retries the TLS handshake while Caddy issues the leaf.
func dialUntil(addr string, cfg *tls.Config, deadline time.Time) (*tls.Conn, error) {
	var last error
	for time.Now().Before(deadline) {
		d := &net.Dialer{Timeout: 2 * time.Second}
		conn, err := tls.DialWithDialer(d, "tcp", addr, cfg)
		if err == nil {
			return conn, nil
		}
		last = err
		time.Sleep(250 * time.Millisecond)
	}
	return nil, fmt.Errorf("TLS handshake never succeeded: %w", last)
}

func TestCaddyAchillesCA(t *testing.T) {
	requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	caDir := filepath.Join(t.TempDir(), "ca")
	b, err := Init(Options{Dir: caDir, Zone: zone, Label: "Integration Test"})
	if err != nil {
		t.Fatal(err)
	}
	caddyfile, rendered := renderAchillesCA(t, t.TempDir())

	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatal(err)
	}
	name := "achilles-caddy-it-" + hex.EncodeToString(suffix)
	// Same mounts as docker-compose.server.yml. The root key is NOT mounted.
	if _, err := dockerCmd(ctx, "run", "-d", "--name", name,
		"--health-cmd", caddyHealthcheck(t), "--health-interval", "1s", "--health-timeout", "5s", "--health-retries", "3",
		"-p", "127.0.0.1::80", "-p", "127.0.0.1::443",
		"-e", "ACHILLES_DOMAIN="+caddyDomain, "-e", "ACME_EMAIL=",
		"-v", caddyfile+":/etc/caddy/Caddyfile:ro",
		"-v", rendered+":/etc/caddy/rendered:ro",
		"-v", filepath.Join(caDir, "caddy")+":/etc/caddy/ca:ro",
		"-v", filepath.Join(caDir, "public")+":/srv/ca:ro",
		caddyImage); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if t.Failed() {
			logs, _ := exec.CommandContext(c, "docker", "logs", name).CombinedOutput()
			t.Logf("caddy logs:\n%s", logs)
		}
		_, _ = dockerCmd(c, "rm", "-f", name)
	})

	httpsAddr := hostPort(t, ctx, name, "443/tcp")
	httpAddr := hostPort(t, ctx, name, "80/tcp")

	roots := x509.NewCertPool()
	roots.AddCert(b.Root)
	tlsCfg := &tls.Config{RootCAs: roots, ServerName: caddyDomain, MinVersion: tls.VersionTLS12}

	t.Run("leaf chains to our intermediate and root", func(t *testing.T) {
		conn, err := dialUntil(httpsAddr, tlsCfg, time.Now().Add(60*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		st := conn.ConnectionState()
		leaf := st.PeerCertificates[0]
		t.Logf("leaf: serial=%x lifetime=%s eku=%v keyUsage=%v; peer chain length %d",
			leaf.SerialNumber, leaf.NotAfter.Sub(leaf.NotBefore), leaf.ExtKeyUsage, leaf.KeyUsage, len(st.PeerCertificates))

		if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != caddyDomain || len(leaf.IPAddresses) != 0 {
			t.Errorf("leaf SANs: DNS=%v IP=%v, want DNS=[%s] and no IPs", leaf.DNSNames, leaf.IPAddresses, caddyDomain)
		}
		if len(st.PeerCertificates) < 2 || st.PeerCertificates[1].SerialNumber.Cmp(b.Intermediate.SerialNumber) != 0 {
			t.Fatalf("Caddy did not send our intermediate (serial %x) after the leaf", b.Intermediate.SerialNumber)
		}
		if !bytes.Equal(leaf.RawIssuer, b.Intermediate.RawSubject) {
			t.Error("leaf issuer is not our intermediate")
		}
		if len(st.VerifiedChains) == 0 {
			t.Fatal("no verified chain")
		}
		ch := st.VerifiedChains[0]
		if len(ch) != 3 || ch[1].SerialNumber.Cmp(b.Intermediate.SerialNumber) != 0 || !ch[2].Equal(b.Root) {
			t.Fatalf("verified chain is not leaf -> our intermediate -> our root (len %d)", len(ch))
		}

		inters := x509.NewCertPool()
		for _, c := range st.PeerCertificates[1:] {
			inters.AddCert(c)
		}
		if _, err := leaf.Verify(x509.VerifyOptions{
			DNSName: caddyDomain, Roots: roots, Intermediates: inters,
			KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		}); err != nil {
			t.Errorf("leaf does not verify for serverAuth: %v", err)
		}
	})

	httpsClient := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tlsCfg,
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, httpsAddr)
			},
		},
	}
	t.Run("https proxies the site", func(t *testing.T) {
		resp, err := httpsClient.Get("https://" + caddyDomain + "/")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK || string(body) != "ok" {
			t.Errorf("GET / over HTTPS = %d %q, want 200 \"ok\"", resp.StatusCode, body)
		}
	})

	plain := &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	get := func(t *testing.T, path string) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+httpAddr+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = caddyDomain
		resp, err := plain.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, body
	}

	t.Run("plain http serves only the root", func(t *testing.T) {
		for _, f := range []struct{ path, file, ctype string }{
			{"/ca/root.cer", "root.cer", "application/x-x509-ca-cert"},
			{"/ca/root.crt", "root.crt", "application/x-pem-file"},
			{"/CA/Root.CER", "root.cer", "application/x-x509-ca-cert"}, // Caddy path matching ignores case
		} {
			want, err := os.ReadFile(filepath.Join(caDir, "public", f.file))
			if err != nil {
				t.Fatal(err)
			}
			resp, body := get(t, f.path)
			if resp.StatusCode != http.StatusOK || !bytes.Equal(body, want) {
				t.Errorf("GET %s = %d (%d bytes), want 200 with public/%s", f.path, resp.StatusCode, len(body), f.file)
			}
			if got := resp.Header.Get("Content-Type"); got != f.ctype {
				t.Errorf("GET %s Content-Type = %q, want %q", f.path, got, f.ctype)
			}
		}
	})

	t.Run("every other http path redirects to https", func(t *testing.T) {
		for _, p := range []string{"/anything", "/", "/ca/", "/ca/root.key", "/ca/intermediate.key", "/ca/root.crt.bak", "/api/agent/download?os=windows"} {
			resp, _ := get(t, p)
			if want := "https://" + caddyDomain + p; resp.StatusCode != http.StatusPermanentRedirect || resp.Header.Get("Location") != want {
				t.Errorf("GET %s = %d Location %q, want 308 %q", p, resp.StatusCode, resp.Header.Get("Location"), want)
			}
		}
	})

	t.Run("container never sees the root key or mints its own CA", func(t *testing.T) {
		if _, err := dockerCmd(ctx, "exec", name, "test", "-e", "/etc/caddy/ca/root.key"); err == nil {
			t.Error("root.key is visible inside the Caddy container")
		}
		var exitErr *exec.ExitError
		out, err := dockerCmd(ctx, "exec", name, "find", "/data", "-name", "*.key", "-path", "*pki*")
		if err != nil && !errors.As(err, &exitErr) {
			t.Fatal(err)
		}
		if strings.TrimSpace(out) != "" {
			t.Errorf("Caddy generated its own CA keys:\n%s", out)
		}
	})

	t.Run("compose healthcheck reports healthy", func(t *testing.T) {
		var status string
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
			out, err := dockerCmd(ctx, "inspect", "-f", "{{.State.Health.Status}}", name)
			if err != nil {
				t.Fatal(err)
			}
			if status = strings.TrimSpace(out); status == "healthy" || status == "unhealthy" {
				break
			}
		}
		if status != "healthy" {
			out, _ := dockerCmd(ctx, "inspect", "-f", "{{json .State.Health}}", name)
			t.Fatalf("health = %q, want healthy: %s", status, out)
		}
	})

	// The host renews the intermediate by renaming files into caddy/. Caddy
	// reads its CA only at startup, so a restart is what picks it up; the
	// directory bind mount must expose the new inode.
	t.Run("renewed intermediate is used after a restart", func(t *testing.T) {
		if renewed, err := Renew(caDir, 3*365*24*time.Hour, nil); err != nil || !renewed {
			t.Fatalf("Renew = %v, %v; want a forced renewal", renewed, err)
		}
		nb, err := Load(caDir)
		if err != nil {
			t.Fatal(err)
		}
		if nb.Intermediate.SerialNumber.Cmp(b.Intermediate.SerialNumber) == 0 {
			t.Fatal("renewal kept the old intermediate")
		}
		restartLikeCARenew(t, ctx, name)
		addr := hostPort(t, ctx, name, "443/tcp") // may change on restart
		conn, err := dialUntil(addr, tlsCfg, time.Now().Add(60*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		st := conn.ConnectionState()
		if len(st.PeerCertificates) < 2 || st.PeerCertificates[1].SerialNumber.Cmp(nb.Intermediate.SerialNumber) != 0 {
			t.Fatalf("after restart Caddy does not chain to the renewed intermediate (serial %x)", nb.Intermediate.SerialNumber)
		}
	})

	// A root rotation: the cached leaf chains to the OLD root, and Caddy
	// would keep serving it after a plain restart (seen in a probe run).
	t.Run("rotated root is used after a restart", func(t *testing.T) {
		nb, err := Init(Options{Dir: caDir, Zone: zone, Label: "Integration Test", Rotate: true})
		if err != nil {
			t.Fatal(err)
		}
		if nb.Root.Equal(b.Root) {
			t.Fatal("rotation kept the old root")
		}
		restartLikeCARenew(t, ctx, name)
		newRoots := x509.NewCertPool()
		newRoots.AddCert(nb.Root)
		cfg := &tls.Config{RootCAs: newRoots, ServerName: caddyDomain, MinVersion: tls.VersionTLS12}
		conn, err := dialUntil(hostPort(t, ctx, name, "443/tcp"), cfg, time.Now().Add(60*time.Second))
		if err != nil {
			t.Fatalf("after rotation + restart the leaf does not verify against the new root: %v", err)
		}
		defer conn.Close()
		if st := conn.ConnectionState(); len(st.PeerCertificates) < 2 || st.PeerCertificates[1].SerialNumber.Cmp(nb.Intermediate.SerialNumber) != 0 {
			t.Fatal("after rotation + restart Caddy does not send the new intermediate")
		}
	})
}

// restartLikeCARenew does what scripts/ca-renew.sh does when the intermediate
// is newer than the container: delete the cached leaves (Caddy would keep
// serving them, chained to the old intermediate or root), then restart.
func restartLikeCARenew(t *testing.T, ctx context.Context, name string) {
	t.Helper()
	if _, err := dockerCmd(ctx, "exec", name, "rm", "-rf", "/data/caddy/certificates/local"); err != nil {
		t.Fatal(err)
	}
	if _, err := dockerCmd(ctx, "restart", name); err != nil {
		t.Fatal(err)
	}
}

// TestCaddyEmptyRendered: a checkout pulled without re-running deploy-server.sh
// has an empty (or missing) deploy/caddy/rendered/. The committed Caddyfile must
// still load: its rendered imports are globs, which only warn on no match,
// where a literal path is a fatal "File to import not found".
func TestCaddyEmptyRendered(t *testing.T) {
	requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	empty := t.TempDir()
	out, err := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-e", "ACHILLES_DOMAIN="+caddyDomain,
		"-v", filepath.Join(repoCaddyDir(t), "Caddyfile")+":/etc/caddy/Caddyfile:ro",
		"-v", empty+":/etc/caddy/rendered:ro",
		caddyImage, "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	).CombinedOutput()
	if err != nil {
		t.Fatalf("caddy validate with an empty rendered/ failed: %v\n%s", err, out)
	}
	for _, p := range []string{"global*.caddy", "tls*.caddy", "sites-extra*.caddy"} {
		if !bytes.Contains(out, []byte("/etc/caddy/rendered/"+p)) {
			t.Errorf("expected a no-match warning for %s:\n%s", p, out)
		}
	}
}

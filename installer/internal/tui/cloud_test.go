package tui

// Cloud servers (DigitalOcean, Hetzner, ...): the public IP sits on the
// interface, so the wizard offers Let's Encrypt HTTP-01 first and skips the
// LAN-subnets question.

import (
	"strings"
	"testing"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
)

const cloudIP = "203.0.113.10"

func cloudDeps(t *testing.T) Deps {
	t.Helper()
	deps := testDeps(t)
	deps.Interfaces = func() []sysprobe.Iface {
		return []sysprobe.Iface{
			{Name: "eth0", IP: cloudIP, CIDR: "203.0.112.0/20", Default: true},
			{Name: "eth1", IP: "10.110.0.2", CIDR: "10.110.0.0/20"},
		}
	}
	deps.Resolver = fakeResolver{ns: map[string]bool{"example.com": true}, hosts: map[string][]string{testHost: {cloudIP}}}
	return deps
}

// cloudToCerts walks to the certificates screen on the public interface.
// The DNS check passes, and there is no subnets question in between.
func (d *driver) cloudToCerts() string {
	d.t.Helper()
	d.passWelcome()
	d.passPreflight()
	d.waitText("Network", "eth0", "public")
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	d.waitText("public name servers")
	d.enter()
	d.waitText("resolves to " + cloudIP)
	d.enter()
	return d.waitText("Certificates", "Let's Encrypt HTTP-01")
}

func TestCloudServerDefaultsToHTTP01(t *testing.T) {
	d := start(t, cloudDeps(t), nil)
	f := d.cloudToCerts()
	if strings.Contains(f, "LAN subnets") {
		t.Fatalf("asked for LAN subnets on a public IP:\n%s", f)
	}
	if !strings.Contains(f, "Let's Encrypt HTTP-01 (recommended)") || strings.Contains(f, "ProjectAchilles CA (recommended)") {
		t.Errorf("HTTP-01 should be the recommended choice on a public IP:\n%s", f)
	}
	d.enter() // default choice
	f = d.waitText("Email for Let's Encrypt")
	flat := strings.Join(strings.Fields(strings.ReplaceAll(f, "┃", "")), " ")
	if !strings.Contains(flat, "port 80") {
		t.Errorf("HTTP-01 step should say port 80 must be reachable:\n%s", f)
	}
	d.typ("ops@example.com")
	d.enter()
	c := d.afterCerts()
	if c.TLSMode != "acme-http" || c.ACMEEmail != "ops@example.com" || c.CaddyBindIP != cloudIP || c.LANSubnets != "" {
		t.Fatalf("TLS_MODE=%q ACME_EMAIL=%q CADDY_BIND_IP=%q LAN_SUBNETS=%q", c.TLSMode, c.ACMEEmail, c.CaddyBindIP, c.LANSubnets)
	}
	if c.CaddyDNSProvider != "" || c.CaddyDNSToken != "" {
		t.Errorf("HTTP-01 wrote DNS-01 settings: %q %q", c.CaddyDNSProvider, c.CaddyDNSToken)
	}
}

func TestCloudServerCanStillChooseProjectAchillesCA(t *testing.T) {
	d := start(t, cloudDeps(t), nil)
	d.cloudToCerts()
	d.down() // Let's Encrypt DNS-01
	d.down() // ProjectAchilles CA
	d.enter()
	d.waitText("name-constrained")
	d.quit()
}

// A LAN server with a name under a public domain gets HTTP-01 as an extra
// option; the ProjectAchilles CA stays the recommendation.
func TestLANServerOffersHTTP01Last(t *testing.T) {
	d := start(t, testDeps(t), nil)
	d.toCerts(testHost)
	f := d.waitText("Let's Encrypt HTTP-01")
	if !strings.Contains(f, "ProjectAchilles CA (recommended)") {
		t.Errorf("CA should stay recommended on a LAN IP:\n%s", f)
	}
	for range 4 {
		d.down()
	}
	d.enter()
	f = d.waitText("Email for Let's Encrypt")
	flat := strings.Join(strings.Fields(strings.ReplaceAll(f, "┃", "")), " ")
	if !strings.Contains(flat, testIP+" is a private address") {
		t.Errorf("HTTP-01 on a LAN IP should warn that ports must be forwarded:\n%s", f)
	}
	d.quit()
}

func TestCloudDNSMismatchShowsPublicRecordOnly(t *testing.T) {
	deps := cloudDeps(t)
	deps.Resolver = fakeResolver{ns: map[string]bool{"example.com": true}} // no A record yet
	d := start(t, deps, nil)
	d.passWelcome()
	d.passPreflight()
	d.waitText("Network", "eth0")
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	d.waitText("public name servers")
	d.enter()
	f := d.waitText("does not resolve", "DNS provider")
	if !strings.Contains(f, testHost+".  A  "+cloudIP) || strings.Contains(f, "Add-DnsServerResourceRecordA") {
		t.Errorf("public IP: want the public A record and no AD command:\n%s", f)
	}
	d.down()
	d.down() // Continue without a record for now
	d.enter()
	d.waitText("Certificates", "Let's Encrypt HTTP-01")
	d.quit()
}

// Behind 1:1 NAT (AWS, Azure, Google Cloud, a DigitalOcean reserved IP) the
// interface has a private address while the name points at the public one.
func TestNATMismatchExplainsContinue(t *testing.T) {
	deps := testDeps(t)
	deps.Resolver = fakeResolver{ns: map[string]bool{"example.com": true}, hosts: map[string][]string{testHost: {cloudIP}}}
	d := start(t, deps, nil)
	d.passWelcome()
	d.passPreflight()
	d.waitText("Network", "ens18")
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	d.waitText("public name servers")
	d.enter()
	f := d.waitText("does not resolve", "NAT")
	flat := strings.Join(strings.Fields(f), " ")
	if !strings.Contains(flat, "Continue without a record") {
		t.Errorf("NAT hint should point at Continue:\n%s", f)
	}
	d.quit()
}

func TestReconfigureKeepsHTTP01WithoutWarning(t *testing.T) {
	existing := &config.Config{
		AchillesDomain: testHost, TLSMode: "acme-http", ACMEEmail: "ops@example.com", CaddyBindIP: cloudIP,
		ClerkPublishableKey: "pk_test_x", ClerkSecretKey: "sk_test_x",
		SessionSecret: "s1", EncryptionSecret: "e1", CLIAuthSecret: "c1",
	}
	d := start(t, cloudDeps(t), existing)
	d.waitText("Reconfigure")
	d.enter()
	d.passPreflight()
	d.waitText("Network", "eth0")
	d.enter()
	d.waitText("Server hostname", testHost)
	d.enter()
	d.waitText("resolves to " + cloudIP)
	d.enter()
	d.waitText("Certificates", "Let's Encrypt HTTP-01")
	d.enter() // the existing mode is pre-selected
	f := d.waitText("Email for Let's Encrypt", "ops@example.com")
	if strings.Contains(f, "Changing the certificate mode") {
		t.Fatalf("warned about a mode change that isn't one:\n%s", f)
	}
	d.enter()
	if c := d.afterCerts(); c.TLSMode != "acme-http" {
		t.Fatalf("TLS_MODE = %q", c.TLSMode)
	}
}

func TestFramesCloud(t *testing.T) {
	deps := cloudDeps(t)
	deps.RepoRoot = "/opt/projectachilles-test"
	d := start(t, deps, nil)
	d.passWelcome()
	d.passPreflight()
	checkGolden(t, "28-network-interface-cloud", d.waitText("Network", "eth0", "public"))
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	d.waitText("public name servers")
	d.enter()
	d.waitText("resolves to " + cloudIP)
	d.enter()
	checkGolden(t, "29-certs-mode-cloud", d.waitText("Certificates", "Let's Encrypt HTTP-01"))
	d.enter()
	checkGolden(t, "30-certs-acme-http", d.waitText("Email for Let's Encrypt"))
	d.quit()
}

// Going back and switching from a private to the public interface must move
// the certificate default to HTTP-01 on a fresh install.
func TestSwitchToPublicInterfaceResetsCertDefault(t *testing.T) {
	d := start(t, cloudDeps(t), nil)
	d.passWelcome()
	d.passPreflight()
	d.waitText("Network", "eth0")
	d.down() // eth1, private
	d.enter()
	d.waitText("Server hostname")
	d.typ(testHost)
	d.waitText("public name servers")
	d.enter()
	d.waitText("does not resolve", "NAT")
	d.down()
	d.down() // Continue without a record
	d.enter()
	d.waitText("LAN subnets")
	d.enter()
	d.waitText("Certificates", "> ProjectAchilles CA (recommended)")
	d.enter() // CA
	d.waitText("name-constrained")
	d.enter()
	d.waitText("the IP 10.110.0.2")
	d.enter()
	d.waitText("Login (Clerk)")
	d.esc() // back to Certificates
	d.waitText("Certificates", "ProjectAchilles CA")
	d.esc() // back to Network
	d.waitText("Network", "eth0")
	d.up()
	d.enter() // eth0, public
	d.waitText("Server hostname", testHost)
	d.enter()
	d.waitText("resolves to " + cloudIP)
	d.enter()
	d.waitText("Certificates", "> Let's Encrypt HTTP-01 (recommended)")
	d.quit()
}

// Leaving DNS-01 for another mode drops its API token from the config.
func TestHTTP01ClearsDNSCredentials(t *testing.T) {
	d := start(t, cloudDeps(t), nil)
	d.cloudToCerts()
	d.down() // DNS-01
	d.enter()
	d.waitText("Email for Let's Encrypt")
	d.typ("ops@example.com")
	d.enter()
	d.typ("digitalocean")
	d.enter()
	d.typ("dop_v1_SECRET")
	d.enter()
	d.waitText("Login (Clerk)")
	d.esc()
	d.waitText("Certificates", "Let's Encrypt HTTP-01")
	d.up() // HTTP-01
	d.enter()
	d.waitText("Email for Let's Encrypt", "ops@example.com")
	d.enter()
	c := d.afterCerts()
	if c.TLSMode != "acme-http" || c.CaddyDNSToken != "" || c.CaddyDNSProvider != "" || c.CaddyDNSModule != "" {
		t.Fatalf("TLS_MODE=%q token=%q provider=%q module=%q", c.TLSMode, c.CaddyDNSToken, c.CaddyDNSProvider, c.CaddyDNSModule)
	}
}

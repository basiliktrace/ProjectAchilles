package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteThenBashSourceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "deploy.config.env")
	org := "Banco Caribe & Co's \"QA\" $1 #x \\"
	sec := "sk_live_ab/+="
	c := Config{OrganizationName: org, ClerkSecretKey: sec}
	if err := c.Write(p); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("bash", "-c",
		`set -a; . "$1"; printf "%s\n%s" "$ORGANIZATION_NAME" "$CLERK_SECRET_KEY"`, "_", p).CombinedOutput()
	if err != nil {
		t.Fatalf("bash: %v: %s", err, out)
	}
	if want := org + "\n" + sec; string(out) != want {
		t.Fatalf("got %q want %q", out, want)
	}
	back, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if back.OrganizationName != org || back.ClerkSecretKey != sec {
		t.Fatalf("Load round trip mismatch: %+v", back)
	}
}

func TestRoundTripNewKeysAndExtras(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.env")
	c := Config{CaddyBindIP: "10.0.0.5", LANSubnets: "10.0.0.0/24,192.168.1.0/24", CAZone: "lan.example",
		CAIncludeIP: true, CARotate: true, HostsEntry: true, TLSMode: "achilles-ca"}
	c.SetExtra("MY_EXTRA", "it's fine")
	if err := c.Write(p); err != nil {
		t.Fatal(err)
	}
	b, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if b.CaddyBindIP != "10.0.0.5" || b.LANSubnets != c.LANSubnets || b.CAZone != "lan.example" ||
		!b.CAIncludeIP || !b.CARotate || !b.HostsEntry || b.TLSMode != "achilles-ca" {
		t.Fatalf("mismatch %+v", b)
	}
	if b.Extra("MY_EXTRA") != "it's fine" {
		t.Fatalf("extra lost: %+v", b)
	}
}

func TestLoadExampleFile(t *testing.T) {
	c, err := Load("../../../deploy.config.env.example")
	if err != nil {
		t.Fatal(err)
	}
	if c.TLSMode != "acme-http" || c.ESMode != "self" || c.RemoteDir != "/opt/projectachilles" {
		t.Fatalf("unexpected: %q %q %q", c.TLSMode, c.ESMode, c.RemoteDir)
	}
	if c.CARotate || c.Extra("CA_ROTATE") != "" {
		t.Fatalf("CA_ROTATE in the example must map to CARotate=false, got %v / extra %q", c.CARotate, c.Extra("CA_ROTATE"))
	}
	if c.DOSize != "s-2vcpu-4gb" {
		t.Fatalf("inline comment not stripped: %q", c.DOSize)
	}
}

func TestLoadQuoting(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.env")
	os.WriteFile(p, []byte("# c\nORGANIZATION_NAME=\"Acme Corp\"  # trailing\nexport ACME_EMAIL='a@b.c'\nACHILLES_DOMAIN=x.example\n"), 0o600)
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.OrganizationName != "Acme Corp" || c.ACMEEmail != "a@b.c" || c.AchillesDomain != "x.example" {
		t.Fatalf("%+v", c)
	}
}

func TestWriteMode0600(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.env")
	if err := (Config{}).Write(p); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
	// overwrite keeps 0600 and leaves no temp files
	if err := (Config{}).Write(p); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(filepath.Dir(p))
	if len(ents) != 1 {
		t.Fatalf("leftover files: %v", ents)
	}
}

func keys(ps []Problem) string {
	var k []string
	for _, p := range ps {
		k = append(k, p.Key)
	}
	return strings.Join(k, ",")
}

func base() Config {
	return Config{AchillesDomain: "a.example", ClerkPublishableKey: "pk", ClerkSecretKey: "sk", TLSMode: "internal", ESMode: "self"}
}

func TestValidateOK(t *testing.T) {
	if ps := base().Validate(); len(ps) != 0 {
		t.Fatalf("%v", ps)
	}
}

func TestValidateAchillesCARequiresZone(t *testing.T) {
	c := base()
	c.TLSMode = "achilles-ca"
	if got := keys(c.Validate()); got != "CADDY_BIND_IP,CA_ZONE" {
		t.Fatalf("got %q", got)
	}
}

func TestValidateByTLSAndES(t *testing.T) {
	c := base()
	c.TLSMode = "acme-dns"
	c.ESMode = "cloud"
	want := "ACME_EMAIL,CADDY_DNS_PROVIDER,CADDY_DNS_TOKEN,ELASTICSEARCH_CLOUD_ID,ELASTICSEARCH_API_KEY"
	if got := keys(c.Validate()); got != want {
		t.Fatalf("got %q", got)
	}
	c = base()
	c.TLSMode, c.ESMode = "bogus", "nope"
	if got := keys(c.Validate()); got != "TLS_MODE,ES_MODE" {
		t.Fatalf("got %q", got)
	}
	if got := keys((Config{}).Validate()); got != "ACHILLES_DOMAIN,CLERK_PUBLISHABLE_KEY,CLERK_SECRET_KEY,ACME_EMAIL" { // empty TLS_MODE defaults to acme-http
		t.Fatalf("empty: %q", got)
	}
}

func TestValidateOrgNameTooLong(t *testing.T) {
	c := base()
	c.OrganizationName = strings.Repeat("a", 56)
	if len(c.Validate()) != 0 {
		t.Fatal("56 should pass")
	}
	c.OrganizationName = strings.Repeat("a", 57)
	if got := keys(c.Validate()); got != "ORGANIZATION_NAME" {
		t.Fatalf("got %q", got)
	}
}

// ADMIN_EMAIL is optional (configs from before it existed stay valid) but must
// look like an address when set.
func TestValidateAdminEmail(t *testing.T) {
	c := base()
	c.AdminEmail = "admin@example.com"
	if len(c.Validate()) != 0 {
		t.Fatal("a real address should pass")
	}
	c.AdminEmail = "admin"
	if got := keys(c.Validate()); got != "ADMIN_EMAIL" {
		t.Fatalf("got %q", got)
	}
	p := filepath.Join(t.TempDir(), "c.env")
	os.WriteFile(p, []byte("ADMIN_EMAIL=ops@example.com\n"), 0o600)
	if l, err := Load(p); err != nil || l.AdminEmail != "ops@example.com" || l.Extra("ADMIN_EMAIL") != "" {
		t.Fatalf("load: %+v %v", l.AdminEmail, err)
	}
}

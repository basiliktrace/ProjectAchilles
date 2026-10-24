package tui

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/ca"
	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tlsfiles"
)

type certStep int

const (
	certMode     certStep = iota // choose how certificates are issued
	certModeWarn                 // reconfigure: TLS mode changes
	certZone                     // achilles-ca: name-constraint zone
	certIP                       // achilles-ca: include the LAN IP?
	certDrift                    // achilles-ca: existing CA differs
	certEntIP                    // enterprise: IP SAN in the request?
	certEntCSR                   // enterprise: show CSR, wait for the chain
	certBYOCert                  // byo: certificate path
	certBYOKey                   // byo: key path
	certACME                     // acme-dns: email, provider, token
	certHTTP                     // acme-http: email
)

// Choices on the mode step. Enterprise CA and bring-your-own both end up as
// TLS_MODE=byo.
const (
	choiceAchilles   = "achilles-ca"
	choiceEnterprise = "enterprise"
	choiceBYO        = "byo"
	choiceACME       = "acme-dns"
	choiceHTTP       = "acme-http"
)

// Files under <repo>/deploy/caddy/certs/ that TLS_MODE=byo reads, plus the
// Enterprise-CA request material.
const (
	certFile       = "cert.pem"
	keyFile        = "key.pem"
	csrFile        = "request.csr"
	pendingKeyFile = "request.key" // the request's key while a live pair is in place
)

var providerRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// The site answers on the DNS name only, so an IP in the certificate does not
// make https://<ip> work; these say so rather than suggesting it would.
const (
	ipCADesc  = "This only lets the CA sign certificates for this IP; it does not make the server reachable by IP (the site answers on its DNS name only). Say No and the CA can't issue for any IP address."
	ipEntDesc = "This only adds the IP to the certificate request; it does not make the server reachable by IP (the site answers on its DNS name only)."
)

// certsScreen chooses the TLS mode and gathers what that mode needs.
type certsScreen struct {
	s    *shared
	step certStep
	form *huh.Form

	choice  string
	proceed bool // certModeWarn answer

	zone      string
	includeIP bool
	bundle    *ca.Bundle
	bundleErr error
	keep      string // certDrift: keep | rotate
	rotateYes bool   // certDrift confirm when keeping is impossible (default No)
	rotate    bool

	entIP      bool
	csrPEM     string
	csrNote    string
	csrErr     error
	pendingKey string // path of the request's key (key.pem or request.key)
	chainPath  string

	certPath, keyPath string

	email, provider, token string

	writeErr error

	// wasCloud is cloud() at the previous visit, so a fresh install that
	// switches between a private and a public interface gets the new default.
	wasCloud *bool
}

func newCerts(s *shared) *certsScreen { return &certsScreen{s: s} }

func (c *certsScreen) Title() string { return "Certificates" }

func (c *certsScreen) certsDir() string {
	return filepath.Join(c.s.deps.RepoRoot, "deploy", "caddy", "certs")
}

// rel shows a path relative to the repo when it is inside it.
func (c *certsScreen) rel(p string) string {
	if r, err := filepath.Rel(c.s.deps.RepoRoot, p); err == nil && !strings.HasPrefix(r, "..") {
		return r
	}
	return p
}

func (c *certsScreen) public() bool { return c.s.class.Kind == dnsclass.PublicDomain }

func (c *certsScreen) host() string { return c.s.cfg.AchillesDomain }

func (c *certsScreen) bindIP() string { return strings.Trim(c.s.cfg.CaddyBindIP, "[]") }

// cloud reports a server listening on a public IP (DigitalOcean, Hetzner...),
// where Let's Encrypt HTTP-01 is the natural choice.
func (c *certsScreen) cloud() bool { return sysprobe.IsPublicIPv4(c.bindIP()) }

func (c *certsScreen) zones() []string {
	if z := c.s.class.ZoneCandidates; len(z) > 0 {
		return z
	}
	return []string{c.host()}
}

func (c *certsScreen) Init() tea.Cmd {
	cfg := c.s.cfg
	mode := cfg.TLSMode
	cloud := c.cloud()
	if c.wasCloud != nil && *c.wasCloud != cloud && c.existingMode() == "" {
		mode = "" // the interface changed: offer that interface's default
	}
	c.wasCloud = &cloud
	if mode == "" {
		mode = c.existingMode() // "" on a fresh install
	}
	switch {
	case mode == "byo":
		if c.choice != choiceEnterprise {
			c.choice = choiceBYO
		}
	case mode == "acme-dns" && c.public():
		c.choice = choiceACME
	case mode == "acme-http" && c.public(), mode == "" && c.public() && cloud:
		c.choice = choiceHTTP
	default:
		c.choice = choiceAchilles
	}
	c.zone = c.zones()[0]
	for _, z := range c.zones() {
		if z == cfg.CAZone {
			c.zone = z
		}
	}
	c.includeIP, c.rotate = cfg.CAIncludeIP, cfg.CARotate
	c.email, c.provider, c.token = cfg.ACMEEmail, cfg.CaddyDNSProvider, cfg.CaddyDNSToken

	c.bundle, c.bundleErr = nil, nil
	if b, err := ca.Load(c.s.deps.CADir); err == nil {
		c.bundle = b
	} else if !errors.Is(err, fs.ErrNotExist) {
		c.bundleErr = err
	}
	return c.toMode()
}

func (c *certsScreen) toMode() tea.Cmd {
	c.step = certMode
	private := []huh.Option[string]{
		huh.NewOption("ProjectAchilles CA: a private CA limited to your zone", choiceAchilles),
		huh.NewOption("Enterprise CA: generate a request (CSR) for your own CA to sign", choiceEnterprise),
		huh.NewOption("Bring your own certificate and key files", choiceBYO),
	}
	dns := huh.NewOption("Let's Encrypt DNS-01: public certificates via your DNS provider", choiceACME)
	http := huh.NewOption("Let's Encrypt HTTP-01: public certificates via inbound port 80", choiceHTTP)
	var opts []huh.Option[string]
	switch {
	case c.public() && c.cloud():
		// A cloud server: the public certificates come first.
		http.Key = "Let's Encrypt HTTP-01 (recommended): public certificates via port 80"
		opts = append(append(opts, http, dns), private...)
	case c.public():
		private[0].Key = "ProjectAchilles CA (recommended): a private CA limited to your zone"
		opts = append(private, dns, http)
	default:
		private[0].Key = "ProjectAchilles CA (recommended): a private CA limited to your zone"
		opts = private
	}
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("How should HTTPS certificates be issued?").
			Options(opts...).
			Value(&c.choice),
	))
	return cmd
}

// tlsMode is the TLS_MODE a choice writes.
func tlsMode(choice string) string {
	if choice == choiceEnterprise {
		return "byo"
	}
	return choice
}

func (c *certsScreen) existingMode() string {
	if c.s.existing == nil || c.s.mode != modeReconfigure {
		return ""
	}
	if m := c.s.existing.TLSMode; m != "" {
		return m
	}
	return "acme-http"
}

func (c *certsScreen) toModeWarn() tea.Cmd {
	c.step = certModeWarn
	c.proceed = false
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Change the certificate mode?").
			Affirmative("Yes, change it").
			Negative("No, choose again").
			Value(&c.proceed),
	))
	return cmd
}

// toChoice starts the sub-steps for the chosen mode.
func (c *certsScreen) toChoice() tea.Cmd {
	switch c.choice {
	case choiceEnterprise:
		return c.toEntIP()
	case choiceBYO:
		return c.toBYOCert()
	case choiceACME:
		return c.toACME()
	case choiceHTTP:
		return c.toHTTP()
	default:
		return c.toZone()
	}
}

func (c *certsScreen) toZone() tea.Cmd {
	c.step = certZone
	opts := make([]huh.Option[string], 0, len(c.zones()))
	for _, z := range c.zones() {
		opts = append(opts, huh.NewOption(z+" (and its subdomains)", z))
	}
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Which DNS zone may the CA issue certificates for?").
			Options(opts...).
			Value(&c.zone),
	))
	return cmd
}

func (c *certsScreen) toIP() tea.Cmd {
	c.step = certIP
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewConfirm().
			Title(fmt.Sprintf("Also allow the IP %s in certificates?", c.bindIP())).
			Description(ipCADesc).
			Affirmative("Yes").
			Negative("No").
			Value(&c.includeIP),
	))
	return cmd
}

// bundlePolicy is the existing CA's zone and IP policy.
func (c *certsScreen) bundlePolicy() (zone string, includeIP bool, ip string) {
	r := c.bundle.Root
	if len(r.PermittedDNSDomains) > 0 {
		zone = r.PermittedDNSDomains[0]
	}
	if len(r.PermittedIPRanges) == 1 {
		return zone, true, r.PermittedIPRanges[0].IP.String()
	}
	return zone, false, ""
}

func describePolicy(zone string, includeIP bool, ip string) string {
	if includeIP {
		return fmt.Sprintf("zone %s, IP %s only", zone, ip)
	}
	return fmt.Sprintf("zone %s, no IP addresses", zone)
}

func (c *certsScreen) drifted() bool {
	if c.bundle == nil {
		return false
	}
	bz, binc, bip := c.bundlePolicy()
	return bz != c.zone || binc != c.includeIP || (c.includeIP && bip != c.bindIP())
}

// canKeep reports whether the existing CA can issue for the hostname.
func (c *certsScreen) canKeep() bool {
	bz, _, _ := c.bundlePolicy()
	h := c.host()
	return h == bz || strings.HasSuffix(h, "."+bz)
}

func (c *certsScreen) toDrift() tea.Cmd {
	c.step = certDrift
	var cmd tea.Cmd
	if !c.canKeep() {
		// Rotation is the only way forward, so it must be an explicit Yes:
		// a bare enter answers No and returns to the zone choice.
		c.rotateYes = false
		c.form, cmd = c.s.newForm(huh.NewGroup(
			huh.NewConfirm().
				Title("Rotate the root CA?").
				Description("A new root replaces the existing one; every endpoint must re-trust it before it trusts this server again.").
				Affirmative("Yes, rotate").
				Negative("No, go back").
				Value(&c.rotateYes),
		))
		return cmd
	}
	bz, binc, bip := c.bundlePolicy()
	c.keep = "keep"
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("What should happen to the existing CA?").
			Options(
				huh.NewOption("Keep the existing CA (uses "+describePolicy(bz, binc, bip)+")", "keep"),
				huh.NewOption("Rotate: new root CA; every endpoint must re-trust it", "rotate"),
			).
			Value(&c.keep),
	))
	return cmd
}

func (c *certsScreen) toEntIP() tea.Cmd {
	c.step = certEntIP
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewConfirm().
			Title(fmt.Sprintf("Include the IP %s in the request?", c.bindIP())).
			Description(ipEntDesc).
			Affirmative("Yes").
			Negative("No").
			Value(&c.entIP),
	))
	return cmd
}

func (c *certsScreen) entIPValue() string {
	if c.entIP {
		return c.bindIP()
	}
	return ""
}

// prepareCSR reuses a matching request from an earlier run (the CA may
// already be signing it) or writes a new key + request. While a live
// cert.pem is in place the new key goes to request.key, so the running
// server's pair stays intact until the signed chain is imported.
func (c *certsScreen) prepareCSR() {
	c.csrPEM, c.csrNote, c.csrErr = "", "", nil
	dir := c.certsDir()
	host, ip := c.host(), c.entIPValue()
	csrPath := filepath.Join(dir, csrFile)
	csr, csrErr := os.ReadFile(csrPath)
	for _, k := range []string{pendingKeyFile, keyFile} {
		kp := filepath.Join(dir, k)
		key, err := os.ReadFile(kp)
		if err == nil && csrErr == nil && tlsfiles.CSRMatches(key, csr, host, ip) {
			c.csrPEM, c.pendingKey = string(csr), kp
			c.csrNote = "Using the existing request generated earlier; its key is unchanged."
			return
		}
	}
	c.pendingKey = filepath.Join(dir, keyFile)
	if _, err := os.Stat(filepath.Join(dir, certFile)); err == nil {
		c.pendingKey = filepath.Join(dir, pendingKeyFile)
	}
	key, req, err := tlsfiles.GenerateCSR(host, ip)
	if err == nil {
		err = tlsfiles.WriteFile(c.pendingKey, key, 0o600)
	}
	if err == nil {
		err = tlsfiles.WriteFile(csrPath, req, 0o644)
	}
	if err != nil {
		c.csrErr = fmt.Errorf("could not write the request: %w", err)
		return
	}
	c.csrPEM = string(req)
}

func (c *certsScreen) toEntCSR() tea.Cmd {
	c.step = certEntCSR
	c.writeErr = nil
	c.prepareCSR()
	if c.csrErr != nil {
		c.form = nil
		return nil
	}
	host, ip, now := c.host(), c.entIPValue(), c.s.now()
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Signed certificate chain (path to the PEM file)").
			Placeholder("/path/to/signed-chain.pem").
			Value(&c.chainPath).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return errors.New("enter the path of the signed chain")
				}
				_, _, err := tlsfiles.LoadPair(strings.TrimSpace(v), c.pendingKey, host, ip, now)
				return err
			}),
	))
	return cmd
}

func (c *certsScreen) toBYOCert() tea.Cmd {
	c.step = certBYOCert
	c.writeErr = nil
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Certificate chain file (PEM: server certificate first, then intermediates)").
			Placeholder("/path/to/server.crt").
			Value(&c.certPath).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return errors.New("enter the certificate file path")
				}
				_, err := os.ReadFile(strings.TrimSpace(v))
				return err
			}),
	))
	return cmd
}

func (c *certsScreen) toBYOKey() tea.Cmd {
	c.step = certBYOKey
	host, now := c.host(), c.s.now()
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Private key file (PEM, without a passphrase)").
			Placeholder("/path/to/server.key").
			Value(&c.keyPath).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return errors.New("enter the private key file path")
				}
				_, _, err := tlsfiles.LoadPair(strings.TrimSpace(c.certPath), strings.TrimSpace(v), host, "", now)
				return err
			}),
	))
	return cmd
}

func (c *certsScreen) toACME() tea.Cmd {
	c.step = certACME
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Email for Let's Encrypt").
			Description("Expiry and account notices go here.").
			Value(&c.email).
			Validate(validEmail),
		huh.NewInput().
			Title("DNS provider").
			Description("The Caddy DNS plugin name, e.g. cloudflare, route53, digitalocean.").
			Value(&c.provider).
			Validate(func(v string) error {
				if !providerRe.MatchString(strings.TrimSpace(v)) {
					return errors.New("use the plugin name in lower case, e.g. cloudflare")
				}
				return nil
			}),
		huh.NewInput().
			Title("DNS provider API token").
			Description("Needs permission to edit TXT records in the public zone.").
			EchoMode(huh.EchoModePassword).
			Value(&c.token).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return errors.New("the API token is required")
				}
				return nil
			}),
	))
	return cmd
}

func (c *certsScreen) toHTTP() tea.Cmd {
	c.step = certHTTP
	var cmd tea.Cmd
	c.form, cmd = c.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Email for Let's Encrypt").
			Description("Expiry and account notices go here.").
			Value(&c.email).
			Validate(validEmail),
	))
	return cmd
}

func validEmail(v string) error {
	v = strings.TrimSpace(v)
	if !strings.Contains(v, "@") || strings.ContainsAny(v, " \t") {
		return errors.New("enter a valid email address")
	}
	return nil
}

// installPair writes the validated pair into deploy/caddy/certs/ (key 0600,
// certificate 0644), unless they already are those files.
func (c *certsScreen) installPair(chain, key []byte, srcCert, srcKey string) error {
	dir := c.certsDir()
	dstCert, dstKey := filepath.Join(dir, certFile), filepath.Join(dir, keyFile)
	if !samePath(srcKey, dstKey) {
		if err := tlsfiles.WriteFile(dstKey, key, 0o600); err != nil {
			return err
		}
	}
	if !samePath(srcCert, dstCert) {
		if err := tlsfiles.WriteFile(dstCert, chain, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func samePath(a, b string) bool {
	aa, err1 := filepath.Abs(a)
	bb, err2 := filepath.Abs(b)
	return err1 == nil && err2 == nil && aa == bb
}

func (c *certsScreen) Back() (bool, tea.Cmd) {
	switch c.step {
	case certModeWarn, certZone, certEntIP, certBYOCert, certACME, certHTTP:
		return true, c.toMode()
	case certIP:
		return true, c.toZone()
	case certDrift:
		return true, c.toIP()
	case certEntCSR:
		return true, c.toEntIP()
	case certBYOKey:
		return true, c.toBYOCert()
	}
	return false, nil
}

func (c *certsScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	completed, cmd := updateForm(c.form, msg)
	if !completed {
		return c, cmd
	}
	next := func(n tea.Cmd) (tea.Model, tea.Cmd) { return c, tea.Batch(cmd, n) }
	switch c.step {
	case certMode:
		if m := c.existingMode(); m != "" && m != tlsMode(c.choice) {
			return next(c.toModeWarn())
		}
		return next(c.toChoice())
	case certModeWarn:
		if !c.proceed {
			return next(c.toMode())
		}
		return next(c.toChoice())
	case certZone:
		return next(c.toIP())
	case certIP:
		c.rotate = false
		if c.drifted() {
			return next(c.toDrift())
		}
		return next(done(c))
	case certDrift:
		if !c.canKeep() {
			if !c.rotateYes {
				return next(c.toZone())
			}
			c.rotate = true
			return next(done(c))
		}
		if c.keep == "keep" {
			c.zone, c.includeIP, _ = c.bundlePolicy()
			c.rotate = false
		} else {
			c.rotate = true
		}
		return next(done(c))
	case certEntIP:
		return next(c.toEntCSR())
	case certEntCSR:
		chainPath := strings.TrimSpace(c.chainPath)
		chain, key, err := tlsfiles.LoadPair(chainPath, c.pendingKey, c.host(), c.entIPValue(), c.s.now())
		if err == nil {
			err = c.installPair(chain, key, chainPath, c.pendingKey)
		}
		if err == nil && filepath.Base(c.pendingKey) == pendingKeyFile {
			err = os.Remove(c.pendingKey)
		}
		if err != nil {
			again := c.toEntCSR()
			c.writeErr = err
			return next(again)
		}
		return next(done(c))
	case certBYOCert:
		return next(c.toBYOKey())
	case certBYOKey:
		cp, kp := strings.TrimSpace(c.certPath), strings.TrimSpace(c.keyPath)
		chain, key, err := tlsfiles.LoadPair(cp, kp, c.host(), "", c.s.now())
		if err == nil {
			err = c.installPair(chain, key, cp, kp)
		}
		if err != nil {
			c.writeErr = err
			return next(c.toBYOKey())
		}
		return next(done(c))
	case certACME, certHTTP:
		return next(done(c))
	}
	return c, cmd
}

func (c *certsScreen) Help() string {
	switch c.step {
	case certDrift:
		if !c.canKeep() {
			return "←/→ choose · enter confirm · esc back · ctrl+c quit"
		}
		return "↑/↓ choose · enter next · esc back · ctrl+c quit"
	case certMode, certZone:
		return "↑/↓ choose · enter next · esc back · ctrl+c quit"
	case certIP, certEntIP, certModeWarn:
		return "←/→ choose · enter next · esc back · ctrl+c quit"
	case certACME:
		return "enter next field · shift+tab previous · esc back · ctrl+c quit"
	}
	return defaultHelp
}

func (c *certsScreen) View() tea.View {
	t := c.s.theme
	w := c.s.width - 2
	var b strings.Builder
	para := func(s string) { b.WriteString(wrap(s, w) + "\n\n") }

	switch c.step {
	case certMode:
		b.WriteString(c.form.View())
		if !c.public() {
			b.WriteString("\n\n" + t.Muted.Render(wrap("Public certificates (Let's Encrypt) aren't offered: "+c.host()+" is a private-only name.", w)))
		}
	case certModeWarn:
		b.WriteString(t.warn(wrap(fmt.Sprintf("Changing the certificate mode from %s to %s on an existing install.", c.existingMode(), tlsMode(c.choice)), w)) + "\n\n")
		para("Browsers and enrolled agents trust the current certificate's issuer. After the change they must trust the new issuer before they can connect again; agents stay offline until then.")
		b.WriteString(c.form.View())
	case certZone:
		para("The ProjectAchilles root CA is name-constrained: it can only ever issue certificates for names in this zone and its subdomains. The zone can't be widened later without re-issuing the root and re-distributing it to every endpoint, so pick the narrowest zone that covers " + c.host() + ".")
		if c.bundle != nil {
			bz, binc, bip := c.bundlePolicy()
			b.WriteString(t.Muted.Render(wrap("Found the existing CA on this server: "+describePolicy(bz, binc, bip)+".", w)) + "\n\n")
		} else if c.bundleErr != nil {
			b.WriteString(t.warn(wrap(fmt.Sprintf("Could not read the existing CA in %s: %v", c.s.deps.CADir, c.bundleErr), w)) + "\n\n")
		}
		b.WriteString(c.form.View())
	case certIP:
		b.WriteString(t.Muted.Render("Zone: "+c.zone) + "\n\n")
		b.WriteString(c.form.View())
	case certDrift:
		bz, binc, bip := c.bundlePolicy()
		b.WriteString(t.warn(wrap("The existing ProjectAchilles CA on this server doesn't match these answers.", w)) + "\n")
		b.WriteString("  Existing: " + describePolicy(bz, binc, bip) + "\n")
		b.WriteString("  Chosen:   " + describePolicy(c.zone, c.includeIP, c.bindIP()) + "\n\n")
		para("A root's constraints can't change without re-issuing the root and re-distributing it to every endpoint (GPO, bootstrap script). Until an endpoint has the new root it won't trust this server.")
		if !c.canKeep() {
			b.WriteString(t.Strong.Render("Keeping it isn't possible:") + "\n")
			b.WriteString(wrap(c.host()+" is outside "+bz+".", w) + "\n")
			b.WriteString(t.Muted.Render(wrap("Answer No to pick another zone, or go back (esc) to change the hostname.", w)) + "\n\n")
		}
		b.WriteString(c.form.View())
	case certEntIP:
		para("The installer creates a private key and a certificate request (CSR) for " + c.host() + " in " + c.rel(c.certsDir()) + "/. Your CA signs the request; you then point the installer at the signed chain.")
		b.WriteString(c.form.View())
	case certEntCSR:
		if c.csrErr != nil {
			b.WriteString(t.bad(wrap(c.csrErr.Error(), w)))
			break
		}
		para("Send this request to your CA for a TLS server certificate (serverAuth), and ask for the full chain in PEM. Saved as " + c.rel(filepath.Join(c.certsDir(), csrFile)) + ".")
		if c.csrNote != "" {
			b.WriteString(t.Muted.Render(wrap(c.csrNote, w)) + "\n")
		}
		b.WriteString(t.Code.Render(strings.TrimRight(c.csrPEM, "\n")) + "\n\n")
		if c.writeErr != nil {
			b.WriteString(t.bad(wrap(c.writeErr.Error(), w)) + "\n")
		}
		b.WriteString(c.form.View())
	case certBYOCert:
		para("The files are validated (the key matches, the name is " + c.host() + ", not expired) and copied to " + c.rel(c.certsDir()) + "/.")
		b.WriteString(c.form.View())
	case certBYOKey:
		b.WriteString(t.Muted.Render(wrap("Certificate: "+strings.TrimSpace(c.certPath), w)) + "\n\n")
		if c.writeErr != nil {
			b.WriteString(t.bad(wrap(c.writeErr.Error(), w)) + "\n\n")
		}
		b.WriteString(c.form.View())
	case certACME:
		b.WriteString(t.Muted.Render(wrap("Caddy proves control of "+c.host()+" through a DNS TXT record, so the server needs no inbound access from the internet.", w)) + "\n\n")
		b.WriteString(c.form.View())
	case certHTTP:
		para("Let's Encrypt checks http://" + c.host() + "/.well-known/acme-challenge/ from the internet: " + c.host() + " must resolve publicly to this server, and port 80 must be open to the internet, including any cloud firewall in front of it.")
		if !c.cloud() {
			b.WriteString(t.warn(wrap(c.bindIP()+" is a private address: this works only if your public IP forwards ports 80 and 443 to it.", w)) + "\n\n")
		}
		b.WriteString(c.form.View())
	}
	return tea.NewView(b.String())
}

// Apply writes the TLS mode and its settings.
func (c *certsScreen) Apply(cfg *config.Config) {
	cfg.TLSMode = tlsMode(c.choice)
	cfg.CARotate = false
	switch c.choice {
	case choiceAchilles:
		cfg.CAZone, cfg.CAIncludeIP, cfg.CARotate = c.zone, c.includeIP, c.rotate
	case choiceHTTP:
		cfg.ACMEEmail = strings.TrimSpace(c.email)
	case choiceACME:
		provider := strings.TrimSpace(c.provider)
		if provider != cfg.CaddyDNSProvider {
			cfg.CaddyDNSModule = "" // the engine derives github.com/caddy-dns/<provider>
		}
		cfg.ACMEEmail, cfg.CaddyDNSProvider, cfg.CaddyDNSToken = strings.TrimSpace(c.email), provider, strings.TrimSpace(c.token)
	}
	if c.choice != choiceACME {
		// No DNS API token left on disk for a mode that doesn't use it.
		cfg.CaddyDNSProvider, cfg.CaddyDNSModule, cfg.CaddyDNSToken = "", "", ""
	}
}

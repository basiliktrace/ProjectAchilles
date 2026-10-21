// Package config reads and writes deploy.config.env, the file that
// scripts/deploy-server.sh sources with `set -a; . file`. The writer is
// bash-safe (every value single-quoted); the reader is a small parser, never
// bash exec.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config mirrors every key in deploy.config.env.example plus the on-prem
// installer keys.
type Config struct {
	AchillesDomain   string
	ACMEEmail        string
	OrganizationName string

	TLSMode     string
	CaddyBindIP string
	LANSubnets  string // comma-separated CIDRs
	CAZone      string
	CAIncludeIP bool
	HostsEntry  bool

	CaddyDNSProvider string
	CaddyDNSModule   string
	CaddyDNSToken    string

	ClerkPublishableKey string
	ClerkSecretKey      string

	SessionSecret    string
	EncryptionSecret string
	CLIAuthSecret    string

	ESMode                    string
	ElasticsearchCloudID      string
	ElasticsearchAPIKey       string
	ElasticsearchIndexPattern string
	SeedES                    string

	TestsRepoURL    string
	TestsRepoBranch string
	AgentRepoURL    string
	AgentRepoBranch string
	GithubToken     string

	DOAPIToken          string
	DORegion            string
	DOSize              string
	DOImage             string
	DODropletName       string
	DOSSHKeyFingerprint string
	DOManageDNS         string

	SSHUser   string
	SSHHost   string
	SSHPort   string
	RemoteDir string

	extra     map[string]string // unknown keys, preserved on Write
	extraKeys []string          // their first-seen order
}

// Problem is a validation failure; Key is the env-var name.
type Problem struct{ Key, Message string }

// field is one row of the single key<->field mapping table. Exactly one of
// s / b is set.
type field struct {
	key string
	s   func(*Config) *string
	b   func(*Config) *bool
}

func str(key string, f func(*Config) *string) field { return field{key: key, s: f} }
func boo(key string, f func(*Config) *bool) field   { return field{key: key, b: f} }

// fields is the ONLY place keys map to struct fields. Order = the order of
// deploy.config.env.example, which is the order Write emits.
var fields = []field{
	str("ACHILLES_DOMAIN", func(c *Config) *string { return &c.AchillesDomain }),
	str("ACME_EMAIL", func(c *Config) *string { return &c.ACMEEmail }),
	str("ORGANIZATION_NAME", func(c *Config) *string { return &c.OrganizationName }),
	str("TLS_MODE", func(c *Config) *string { return &c.TLSMode }),
	str("CADDY_BIND_IP", func(c *Config) *string { return &c.CaddyBindIP }),
	str("LAN_SUBNETS", func(c *Config) *string { return &c.LANSubnets }),
	str("CA_ZONE", func(c *Config) *string { return &c.CAZone }),
	boo("CA_INCLUDE_IP", func(c *Config) *bool { return &c.CAIncludeIP }),
	boo("HOSTS_ENTRY", func(c *Config) *bool { return &c.HostsEntry }),
	str("CADDY_DNS_PROVIDER", func(c *Config) *string { return &c.CaddyDNSProvider }),
	str("CADDY_DNS_MODULE", func(c *Config) *string { return &c.CaddyDNSModule }),
	str("CADDY_DNS_TOKEN", func(c *Config) *string { return &c.CaddyDNSToken }),
	str("CLERK_PUBLISHABLE_KEY", func(c *Config) *string { return &c.ClerkPublishableKey }),
	str("CLERK_SECRET_KEY", func(c *Config) *string { return &c.ClerkSecretKey }),
	str("SESSION_SECRET", func(c *Config) *string { return &c.SessionSecret }),
	str("ENCRYPTION_SECRET", func(c *Config) *string { return &c.EncryptionSecret }),
	str("CLI_AUTH_SECRET", func(c *Config) *string { return &c.CLIAuthSecret }),
	str("ES_MODE", func(c *Config) *string { return &c.ESMode }),
	str("ELASTICSEARCH_CLOUD_ID", func(c *Config) *string { return &c.ElasticsearchCloudID }),
	str("ELASTICSEARCH_API_KEY", func(c *Config) *string { return &c.ElasticsearchAPIKey }),
	str("ELASTICSEARCH_INDEX_PATTERN", func(c *Config) *string { return &c.ElasticsearchIndexPattern }),
	str("SEED_ES", func(c *Config) *string { return &c.SeedES }),
	str("TESTS_REPO_URL", func(c *Config) *string { return &c.TestsRepoURL }),
	str("TESTS_REPO_BRANCH", func(c *Config) *string { return &c.TestsRepoBranch }),
	str("AGENT_REPO_URL", func(c *Config) *string { return &c.AgentRepoURL }),
	str("AGENT_REPO_BRANCH", func(c *Config) *string { return &c.AgentRepoBranch }),
	str("GITHUB_TOKEN", func(c *Config) *string { return &c.GithubToken }),
	str("DO_API_TOKEN", func(c *Config) *string { return &c.DOAPIToken }),
	str("DO_REGION", func(c *Config) *string { return &c.DORegion }),
	str("DO_SIZE", func(c *Config) *string { return &c.DOSize }),
	str("DO_IMAGE", func(c *Config) *string { return &c.DOImage }),
	str("DO_DROPLET_NAME", func(c *Config) *string { return &c.DODropletName }),
	str("DO_SSH_KEY_FINGERPRINT", func(c *Config) *string { return &c.DOSSHKeyFingerprint }),
	str("DO_MANAGE_DNS", func(c *Config) *string { return &c.DOManageDNS }),
	str("SSH_USER", func(c *Config) *string { return &c.SSHUser }),
	str("SSH_HOST", func(c *Config) *string { return &c.SSHHost }),
	str("SSH_PORT", func(c *Config) *string { return &c.SSHPort }),
	str("REMOTE_DIR", func(c *Config) *string { return &c.RemoteDir }),
}

func lookup(key string) (field, bool) {
	for _, f := range fields {
		if f.key == key {
			return f, true
		}
	}
	return field{}, false
}

// SetExtra records a key not in the mapping table; it is written after the
// known keys.
func (c *Config) SetExtra(key, val string) {
	if c.extra == nil {
		c.extra = map[string]string{}
	}
	if _, ok := c.extra[key]; !ok {
		c.extraKeys = append(c.extraKeys, key)
	}
	c.extra[key] = val
}

// Extra returns a preserved unknown key's value ("" if absent).
func (c Config) Extra(key string) string { return c.extra[key] }

// Load parses a deploy.config.env (quoted or the unquoted example format).
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	pairs, err := parse(string(data))
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	var c Config
	for _, p := range pairs {
		f, ok := lookup(p[0])
		switch {
		case !ok:
			c.SetExtra(p[0], p[1])
		case f.s != nil:
			*f.s(&c) = p[1]
		default:
			*f.b(&c) = strings.EqualFold(strings.TrimSpace(p[1]), "true")
		}
	}
	return c, nil
}

// Write atomically writes the file (mode 0600): known keys in example order,
// each single-quoted, then preserved unknown keys.
func (c Config) Write(path string) error {
	var sb strings.Builder
	sb.WriteString("# Generated by achilles-installer. Sourced by bash (set -a; . file). Contains secrets.\n")
	for _, f := range fields {
		var v string
		if f.s != nil {
			v = *f.s(&c)
		} else if *f.b(&c) {
			v = "true"
		} else {
			v = "false"
		}
		sb.WriteString(f.key + "=" + shQuote(v) + "\n")
	}
	for _, k := range c.extraKeys {
		sb.WriteString(k + "=" + shQuote(c.extra[k]) + "\n")
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), ".deploy.config.env.*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after successful rename
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(sb.String()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func shQuote(v string) string { return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'" }

// parse handles KEY=value, KEY='...', KEY="...", concatenated segments,
// optional `export`, and # comments (full-line and trailing after whitespace).
func parse(s string) ([][2]string, error) {
	var out [][2]string
	i, n := 0, len(s)
	for i < n {
		// skip leading blanks / blank lines
		for i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
			i++
		}
		if i >= n {
			break
		}
		if s[i] == '#' {
			for i < n && s[i] != '\n' {
				i++
			}
			continue
		}
		lineStart := i
		start := i
		for i < n && isKeyChar(s[i], i == start) {
			i++
		}
		key := s[start:i]
		if key == "export" && i < n && (s[i] == ' ' || s[i] == '\t') {
			for i < n && (s[i] == ' ' || s[i] == '\t') {
				i++
			}
			start = i
			for i < n && isKeyChar(s[i], i == start) {
				i++
			}
			key = s[start:i]
		}
		if key == "" || i >= n || s[i] != '=' {
			return nil, fmt.Errorf("line %d: expected KEY=value", 1+strings.Count(s[:lineStart], "\n"))
		}
		i++ // '='
		var val strings.Builder
	value:
		for i < n {
			switch ch := s[i]; {
			case ch == '\'':
				j := strings.IndexByte(s[i+1:], '\'')
				if j < 0 {
					return nil, fmt.Errorf("key %s: unterminated single quote", key)
				}
				val.WriteString(s[i+1 : i+1+j])
				i += j + 2
			case ch == '"':
				i++
				closed := false
				for i < n {
					if s[i] == '"' {
						i++
						closed = true
						break
					}
					if s[i] == '\\' && i+1 < n && strings.IndexByte("\"\\$`\n", s[i+1]) >= 0 {
						if s[i+1] != '\n' {
							val.WriteByte(s[i+1])
						}
						i += 2
						continue
					}
					val.WriteByte(s[i])
					i++
				}
				if !closed {
					return nil, fmt.Errorf("key %s: unterminated double quote", key)
				}
			case ch == '\\' && i+1 < n:
				if s[i+1] != '\n' {
					val.WriteByte(s[i+1])
				}
				i += 2
			case ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r':
				break value
			default:
				val.WriteByte(ch)
				i++
			}
		}
		// rest of line: only whitespace or a # comment is legal
		for i < n && s[i] != '\n' {
			if s[i] == '#' {
				for i < n && s[i] != '\n' {
					i++
				}
				break
			}
			if s[i] != ' ' && s[i] != '\t' && s[i] != '\r' {
				return nil, fmt.Errorf("key %s: unexpected text after value", key)
			}
			i++
		}
		out = append(out, [2]string{key, val.String()})
	}
	return out, nil
}

func isKeyChar(b byte, first bool) bool {
	return b == '_' || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (!first && b >= '0' && b <= '9')
}

// Validate mirrors scripts/deploy-server.sh section 2. Empty TLS_MODE / ES_MODE
// take the engine defaults (acme-http / self). byo cert-file checks are the
// engine's job.
func (c Config) Validate() []Problem {
	var ps []Problem
	req := func(key, val, what string) {
		if strings.TrimSpace(val) == "" {
			ps = append(ps, Problem{key, what + " is required"})
		}
	}
	req("ACHILLES_DOMAIN", c.AchillesDomain, "Public domain")
	req("CLERK_PUBLISHABLE_KEY", c.ClerkPublishableKey, "Clerk publishable key")
	req("CLERK_SECRET_KEY", c.ClerkSecretKey, "Clerk secret key")

	switch tls := orDefault(c.TLSMode, "acme-http"); tls {
	case "acme-http":
		req("ACME_EMAIL", c.ACMEEmail, "Email for Let's Encrypt")
	case "acme-dns":
		req("ACME_EMAIL", c.ACMEEmail, "Email for Let's Encrypt")
		req("CADDY_DNS_PROVIDER", c.CaddyDNSProvider, "Caddy DNS provider")
		req("CADDY_DNS_TOKEN", c.CaddyDNSToken, "DNS provider API token")
	case "internal", "byo":
	case "achilles-ca":
		req("CADDY_BIND_IP", c.CaddyBindIP, "LAN bind IP")
		req("CA_ZONE", c.CAZone, "CA DNS zone")
	default:
		ps = append(ps, Problem{"TLS_MODE", fmt.Sprintf("invalid TLS_MODE %q (expected: acme-http | acme-dns | internal | byo | achilles-ca)", tls)})
	}

	switch es := orDefault(c.ESMode, "self"); es {
	case "self":
	case "cloud":
		req("ELASTICSEARCH_CLOUD_ID", c.ElasticsearchCloudID, "Elastic Cloud ID")
		req("ELASTICSEARCH_API_KEY", c.ElasticsearchAPIKey, "Elastic Cloud API key")
	default:
		ps = append(ps, Problem{"ES_MODE", fmt.Sprintf("invalid ES_MODE %q (expected: self | cloud)", es)})
	}

	if n := len([]rune(c.OrganizationName)); n > 56 {
		ps = append(ps, Problem{"ORGANIZATION_NAME", fmt.Sprintf("must be at most 56 characters (got %d)", n)})
	}
	return ps
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

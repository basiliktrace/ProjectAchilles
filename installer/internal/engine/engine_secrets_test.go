package engine

import "testing"

// A blank secret in deploy.config.env is generated once and then reused from
// the existing backend/.env on every later run. Found in the E2E run: each
// re-run, Reconfigure or upgrade (the TUI saves the secrets blank) generated
// new SESSION/ENCRYPTION/CLI_AUTH secrets, so settings the backend had
// encrypted with ENCRYPTION_SECRET could no longer be decrypted.
func TestEngineBlankSecretsSurviveReRun(t *testing.T) {
	keys := []string{"SESSION_SECRET", "ENCRYPTION_SECRET", "CLI_AUTH_SECRET"}
	blank := "SESSION_SECRET=\nENCRYPTION_SECRET=\nCLI_AUTH_SECRET=\n"
	s := newSandbox(t, "achilles-ca", blank)

	s.mustRun(t, nil)
	first := readFile(t, s.path("backend", ".env"))
	for _, k := range keys {
		v, ok := envValue(first, k)
		if !ok || len(v) < 32 {
			t.Fatalf("first run: %s = %q, want a generated secret", k, v)
		}
	}

	s.mustRun(t, nil)
	second := readFile(t, s.path("backend", ".env"))
	for _, k := range keys {
		a, _ := envValue(first, k)
		b, _ := envValue(second, k)
		if a != b {
			t.Errorf("%s changed on re-run", k)
		}
	}

	// A value set in the config still wins over the existing one.
	s.setConfig(t, readFile(t, s.cfg)+"ENCRYPTION_SECRET=from-config-encryption-secret-0123456789\n")
	s.mustRun(t, nil)
	third := readFile(t, s.path("backend", ".env"))
	if v, _ := envValue(third, "ENCRYPTION_SECRET"); v != "from-config-encryption-secret-0123456789" {
		t.Errorf("config value ignored: ENCRYPTION_SECRET = %q", v)
	}
	a, _ := envValue(first, "SESSION_SECRET")
	b, _ := envValue(third, "SESSION_SECRET")
	if a != b {
		t.Errorf("SESSION_SECRET changed when only ENCRYPTION_SECRET was set")
	}
}

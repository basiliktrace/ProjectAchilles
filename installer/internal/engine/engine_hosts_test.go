package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const hostsLine = "10.0.5.20 achilles.corp.example.com # projectachilles"

// hostsSandbox is an achilles-ca sandbox whose /etc/hosts is a temp file
// holding initial, with sudo stubbed to log and run its arguments.
func hostsSandbox(t *testing.T, extra, initial string) (*sandbox, string) {
	t.Helper()
	s := newSandbox(t, "achilles-ca", extra)
	hosts := s.path("etc-hosts")
	writeFile(t, hosts, initial, 0o644)
	s.env["ACHILLES_HOSTS_FILE_OVERRIDE"] = hosts
	s.env["ACHILLES_PROGRESS"] = "1"
	writeFile(t, filepath.Join(s.stubs, "sudo"), "#!/bin/sh\necho \"sudo $*\" >> \"$STUB_LOG\"\nexec \"$@\"\n", 0o755)
	return s, hosts
}

func TestHostsEntryAddedOnceAcrossRuns(t *testing.T) {
	s, hosts := hostsSandbox(t, "HOSTS_ENTRY=true\n", "127.0.0.1 localhost\n::1 localhost\n")
	want := "127.0.0.1 localhost\n::1 localhost\n" + hostsLine + "\n"
	for run := 1; run <= 2; run++ {
		r := s.mustRun(t, nil)
		if got := readFile(t, hosts); got != want {
			t.Fatalf("run %d: hosts =\n%s\nwant\n%s", run, got, want)
		}
		if ids := phaseIDs(t, r); ids[0] != "config" {
			t.Fatalf("phases = %v", ids)
		}
	}
}

func TestHostsEntryReplacesStaleLine(t *testing.T) {
	initial := "127.0.0.1 localhost\n" +
		"10.0.0.9 old.corp.example.com # projectachilles\n" +
		"192.168.1.1 router\n" +
		"10.0.0.8 dup.corp.example.com # projectachilles\n" +
		"10.0.0.7 mine # projectachilles-not-ours\n"
	s, hosts := hostsSandbox(t, "HOSTS_ENTRY=true\n", initial)
	s.mustRun(t, nil)
	want := "127.0.0.1 localhost\n" +
		hostsLine + "\n" +
		"192.168.1.1 router\n" +
		"10.0.0.7 mine # projectachilles-not-ours\n"
	if got := readFile(t, hosts); got != want {
		t.Fatalf("hosts =\n%s\nwant\n%s", got, want)
	}
}

func TestHostsEntryNoTrailingNewline(t *testing.T) {
	s, hosts := hostsSandbox(t, "HOSTS_ENTRY=true\n", "127.0.0.1 localhost")
	s.mustRun(t, nil)
	if got, want := readFile(t, hosts), "127.0.0.1 localhost\n"+hostsLine+"\n"; got != want {
		t.Fatalf("hosts = %q, want %q", got, want)
	}
}

func TestHostsEntryIPv6BindIPWithoutBrackets(t *testing.T) {
	s, hosts := hostsSandbox(t, "HOSTS_ENTRY=true\nCADDY_BIND_IP=[fd00::5]\n", "127.0.0.1 localhost\n")
	s.mustRun(t, nil)
	if got := readFile(t, hosts); !strings.Contains(got, "\nfd00::5 achilles.corp.example.com # projectachilles\n") {
		t.Fatalf("hosts = %q", got)
	}
}

func TestHostsEntryUntouchedWhenNotTrue(t *testing.T) {
	initial := "127.0.0.1 localhost\n10.0.0.9 old.corp.example.com # projectachilles\n"
	for name, extra := range map[string]string{"false": "HOSTS_ENTRY=false\n", "unset": "HOSTS_ENTRY=\n"} {
		t.Run(name, func(t *testing.T) {
			s, hosts := hostsSandbox(t, extra, initial)
			fi0, _ := os.Stat(hosts)
			s.mustRun(t, nil)
			if got := readFile(t, hosts); got != initial {
				t.Fatalf("hosts changed:\n%s", got)
			}
			if fi, _ := os.Stat(hosts); !fi.ModTime().Equal(fi0.ModTime()) {
				t.Error("hosts file rewritten")
			}
			for _, l := range stubLines(t, s, "sudo") {
				if strings.Contains(l, hosts) {
					t.Errorf("hosts file touched via sudo: %s", l)
				}
			}
		})
	}
}

func TestHostsEntryRejectsUnsafeValues(t *testing.T) {
	cases := map[string]string{
		"bind IP with a space":  "CADDY_BIND_IP='10.0.5.20 evil.example.com'\n",
		"domain with a newline": "ACHILLES_DOMAIN=$'achilles.corp.example.com\\n6.6.6.6 bank.example'\n",
		"missing bind IP":       "CADDY_BIND_IP=\n",
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			initial := "127.0.0.1 localhost\n"
			s, hosts := hostsSandbox(t, "HOSTS_ENTRY=true\n"+extra, initial)
			r := s.run(t, nil, s.cfg)
			if e, ok := failEvent(t, r); r.code == 0 || !ok || e.id != "config" {
				t.Fatalf("want ::fail config\n%s", r)
			}
			if got := readFile(t, hosts); got != initial {
				t.Fatalf("hosts changed:\n%s", got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// CA_ROTATE
// ---------------------------------------------------------------------------

func TestEngineCARotateOnlyWhenConstraintsChange(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "")
	s.mustRun(t, nil)
	first := rootCert(t, s.caDir).SerialNumber

	// Zone change without CA_ROTATE: the ca phase refuses.
	s.setConfig(t, readFile(t, s.cfg)+"CA_ZONE=example.com\n")
	r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.cfg)
	if e, ok := failEvent(t, r); r.code == 0 || !ok || e.id != "ca" {
		t.Fatalf("want ::fail ca without CA_ROTATE\n%s", r)
	}
	if got := rootCert(t, s.caDir).SerialNumber; got.Cmp(first) != 0 {
		t.Fatal("root replaced without CA_ROTATE")
	}

	// With CA_ROTATE=true it rotates once ...
	s.setConfig(t, readFile(t, s.cfg)+"CA_ROTATE=true\n")
	s.mustRun(t, nil)
	rotated := rootCert(t, s.caDir)
	if rotated.SerialNumber.Cmp(first) == 0 || rotated.PermittedDNSDomains[0] != "example.com" {
		t.Fatalf("CA_ROTATE=true did not rotate to example.com: %v", rotated.PermittedDNSDomains)
	}
	// ... and a re-run with the flag still set keeps the new root.
	s.mustRun(t, nil)
	if got := rootCert(t, s.caDir).SerialNumber; got.Cmp(rotated.SerialNumber) != 0 {
		t.Fatal("re-run with CA_ROTATE=true rotated again")
	}
}

func TestEngineCARotateInvalidValue(t *testing.T) {
	s := newSandbox(t, "achilles-ca", "CA_ROTATE=yes-please\n")
	r := s.run(t, map[string]string{"ACHILLES_PROGRESS": "1"}, s.cfg)
	if e, ok := failEvent(t, r); r.code == 0 || !ok || e.id != "validate" {
		t.Fatalf("want ::fail validate\n%s", r)
	}
}

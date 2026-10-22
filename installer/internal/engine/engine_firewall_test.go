package engine

import (
	"path/filepath"
	"strings"
	"testing"
)

// Firewall phase tests: ufw / firewall-cmd / sudo are PATH shims that log
// their argv to the stub log. The ufw shim keeps its rule list in a file so
// the idempotence check sees what earlier calls added.

const fwSubnets = "10.0.5.0/24,192.168.7.0/24"

func fwSandbox(t *testing.T) *sandbox {
	t.Helper()
	s := newSandbox(t, "internal", "LAN_SUBNETS=\""+fwSubnets+"\"\n")
	s.env["ACHILLES_FIREWALL_TEST"] = "1"
	s.env["FW_DIR"] = s.path("fw")
	s.env["ACHILLES_PROGRESS"] = "1"
	writeFile(t, filepath.Join(s.stubs, "sudo"), "#!/bin/sh\nexec \"$@\"\n", 0o755)
	// Default to "no firewall" so a real host ufw/firewall-cmd never leaks in.
	addUfw(t, s, false)
	addFirewalld(t, s, false)
	return s
}

// addUfw installs a ufw shim. active=false makes `ufw status` report inactive.
func addUfw(t *testing.T, s *sandbox, active bool) {
	t.Helper()
	status := "Status: active"
	if !active {
		status = "Status: inactive"
	}
	writeFile(t, filepath.Join(s.stubs, "ufw"), `#!/bin/sh
echo "ufw $*" >> "$STUB_LOG"
mkdir -p "$FW_DIR"; touch "$FW_DIR/ufw.rules"
case "$1" in
  status)
    echo "`+status+`"
    if [ "`+status+`" = "Status: active" ]; then
      echo; echo "To                         Action      From"
      echo "--                         ------      ----"
      echo "22/tcp                     ALLOW       Anywhere"
      cat "$FW_DIR/ufw.rules"
    fi ;;
  allow)
    # allow from CIDR to any port P proto X comment C
    printf '%-26s ALLOW       %-18s # %s\n' "$7/$9" "$3" "${11}" >> "$FW_DIR/ufw.rules" ;;
esac
exit 0
`, 0o755)
}

func addFirewalld(t *testing.T, s *sandbox, running bool) {
	t.Helper()
	state := "running"
	if !running {
		state = "not running"
	}
	writeFile(t, filepath.Join(s.stubs, "firewall-cmd"), `#!/bin/sh
echo "firewall-cmd $*" >> "$STUB_LOG"
mkdir -p "$FW_DIR"; touch "$FW_DIR/fwd.rules"
case "$1" in
  --state) echo "`+state+`"; [ "`+state+`" = running ] ;;
  --permanent)
    case "$2" in
      --query-rich-rule=*) grep -qxF -- "${2#--query-rich-rule=}" "$FW_DIR/fwd.rules"; exit $? ;;
      --add-rich-rule=*) echo "${2#--add-rich-rule=}" >> "$FW_DIR/fwd.rules" ;;
    esac ;;
esac
exit 0
`, 0o755)
}

func allCalls(t *testing.T, s *sandbox, prefix string) []string { return stubLines(t, s, prefix) }

func TestFirewallUfwActiveAddsRulesOnce(t *testing.T) {
	s := fwSandbox(t)
	addUfw(t, s, true)
	r1 := s.mustRun(t, nil)
	r2 := s.mustRun(t, nil)
	for _, r := range []result{r1, r2} {
		found := false
		for _, id := range phaseIDs(t, r) {
			if id == "firewall" {
				found = true
			}
		}
		if !found {
			t.Fatalf("no firewall phase\n%s", r)
		}
	}
	var allows []string
	for _, l := range allCalls(t, s, "ufw allow") {
		allows = append(allows, l)
	}
	if len(allows) != 6 {
		t.Fatalf("want 6 allow calls (3 per subnet, once across two runs), got %d:\n%s", len(allows), strings.Join(allows, "\n"))
	}
	for _, sn := range strings.Split(fwSubnets, ",") {
		for _, pp := range []string{"port 80 proto tcp", "port 443 proto tcp", "port 443 proto udp"} {
			want := "ufw allow from " + sn + " to any " + pp + " comment projectachilles"
			n := 0
			for _, l := range allows {
				if l == want {
					n++
				}
			}
			if n != 1 {
				t.Errorf("%q called %d times, want 1", want, n)
			}
		}
	}
}

func TestFirewallUfwInactiveNoChanges(t *testing.T) {
	s := fwSandbox(t)
	addUfw(t, s, false)
	r := s.mustRun(t, map[string]string{"ACHILLES_PROGRESS": "1"})
	for _, l := range allCalls(t, s, "ufw") {
		if l != "ufw status" {
			t.Errorf("unexpected ufw call %q", l)
		}
	}
	warned := false
	for _, e := range events(t, r.stdout) {
		if e.kind == "warn" && strings.Contains(e.text, "No active host firewall") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("expected ::warn about no active firewall\n%s", r)
	}
}

func TestFirewallNoLANSubnetsSkipsSilently(t *testing.T) {
	s := fwSandbox(t)
	s.setConfig(t, strings.ReplaceAll(readFile(t, s.cfg), "LAN_SUBNETS=", "#LAN_SUBNETS="))
	s.env["ACHILLES_PROGRESS"] = "1"
	addUfw(t, s, true)
	r := s.mustRun(t, nil)
	for _, id := range phaseIDs(t, r) {
		if id == "firewall" {
			t.Fatal("firewall phase ran without LAN_SUBNETS")
		}
	}
	if len(allCalls(t, s, "ufw")) != 0 {
		t.Fatal("ufw touched without LAN_SUBNETS")
	}
}

func TestFirewallSkippedInRenderOnlyWithoutTestFlag(t *testing.T) {
	s := fwSandbox(t)
	addUfw(t, s, true)
	s.mustRun(t, map[string]string{"ACHILLES_FIREWALL_TEST": ""})
	if len(allCalls(t, s, "ufw")) != 0 {
		t.Fatal("render-only touched the firewall")
	}
}

func TestFirewallInvalidSubnetFailsValidate(t *testing.T) {
	for _, bad := range []string{"10.0.5.0", "10.0.5.0/33", "300.1.1.0/24", "evil;rm/24", "10.0.5.0/24,foo"} {
		s := newSandbox(t, "internal", "LAN_SUBNETS=\""+bad+"\"\n")
		r := s.run(t, nil, s.cfg)
		if r.code == 0 {
			t.Errorf("%q accepted", bad)
			continue
		}
		if e, ok := failEvent(t, r); ok && e.id != "validate" {
			t.Errorf("%q failed in %s", bad, e.id)
		}
		if !strings.Contains(r.stderr, "invalid LAN_SUBNETS entry") {
			t.Errorf("%q: missing message\n%s", bad, r)
		}
	}
}

func TestFirewalldRichRules(t *testing.T) {
	s := fwSandbox(t)
	s.setConfig(t, readFile(t, s.cfg)+"LAN_SUBNETS=\"10.0.5.0/24, fd00:1::/64\"\n")
	addFirewalld(t, s, true)
	s.mustRun(t, nil)
	adds := allCalls(t, s, "firewall-cmd --permanent --add-rich-rule")
	if len(adds) != 6 {
		t.Fatalf("want 6 adds, got %d:\n%s\nLOG:\n%s", len(adds), strings.Join(adds, "\n"), readFile(t, s.stubLog))
	}
	want := `firewall-cmd --permanent --add-rich-rule=rule family="ipv4" source address="10.0.5.0/24" port port="443" protocol="udp" accept`
	if !contains(adds, want) {
		t.Errorf("missing %q in\n%s", want, strings.Join(adds, "\n"))
	}
	want6 := `firewall-cmd --permanent --add-rich-rule=rule family="ipv6" source address="fd00:1::/64" port port="80" protocol="tcp" accept`
	if !contains(adds, want6) {
		t.Errorf("missing %q", want6)
	}
	if n := len(allCalls(t, s, "firewall-cmd --reload")); n != 1 {
		t.Errorf("want 1 reload, got %d", n)
	}
	// Second run: everything present, so no adds and no reload.
	s.mustRun(t, nil)
	if n := len(allCalls(t, s, "firewall-cmd --permanent --add-rich-rule")); n != 6 {
		t.Errorf("second run added rules: %d total adds", n)
	}
	if n := len(allCalls(t, s, "firewall-cmd --reload")); n != 1 {
		t.Errorf("second run reloaded: %d", n)
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func TestFirewallBothActiveHandlesOnlyUfw(t *testing.T) {
	s := fwSandbox(t)
	addUfw(t, s, true)
	addFirewalld(t, s, true)
	r := s.mustRun(t, map[string]string{"ACHILLES_PROGRESS": "1"})
	if len(allCalls(t, s, "firewall-cmd --permanent")) != 0 {
		t.Error("firewalld rules added although ufw handled")
	}
	if !strings.Contains(r.stdout, "::warn") || !strings.Contains(r.stdout, "firewalld is also active") {
		t.Errorf("missing firewalld-also-active warn\n%s", r)
	}
}

func TestFirewallNeverEnablesOrTouches22(t *testing.T) {
	scenarios := map[string]func(*testing.T, *sandbox){
		"ufw-active":     func(t *testing.T, s *sandbox) { addUfw(t, s, true) },
		"ufw-inactive":   func(t *testing.T, s *sandbox) { addUfw(t, s, false) },
		"firewalld":      func(t *testing.T, s *sandbox) { addFirewalld(t, s, true) },
		"firewalld-down": func(t *testing.T, s *sandbox) { addFirewalld(t, s, false) },
		"both-inactive": func(t *testing.T, s *sandbox) {
			addUfw(t, s, false)
			addFirewalld(t, s, false)
		},
	}
	for name, setup := range scenarios {
		t.Run(name, func(t *testing.T) {
			s := fwSandbox(t)
			setup(t, s)
			s.mustRun(t, nil)
			for _, l := range stubLines(t, s, "") {
				if strings.Contains(l, "enable") || strings.Contains(l, " 22") || strings.Contains(l, "firewalld") && strings.HasPrefix(l, "systemctl") {
					t.Errorf("forbidden call: %q", l)
				}
			}
		})
	}
}

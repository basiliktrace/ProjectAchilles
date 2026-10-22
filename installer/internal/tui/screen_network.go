package tui

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/dnsclass"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
)

// classifyDebounce is how long the hostname must stay unchanged before the
// live DNS classification runs.
const classifyDebounce = 400 * time.Millisecond

type netStep int

const (
	netIface    netStep = iota // pick the LAN interface
	netHost                    // type the hostname (live classification)
	netChecking                // classify + resolve in flight
	netDNS                     // resolution result (and the mismatch choices)
	netSubnets                 // confirm LAN_SUBNETS
)

// networkScreen picks the LAN address, the server name and the subnets
// allowed to reach it, and checks the name resolves to the address.
type networkScreen struct {
	s    *shared
	step netStep
	form *huh.Form

	ifaces   []sysprobe.Iface
	ifaceIdx int
	host     string
	subnets  string
	autoNet  string // the subnet value we filled in ourselves

	// live classification of the hostname field
	seq       int
	lastTyped string
	class     *dnsclass.Result

	// DNS check
	gen       int
	resolved  bool
	addrs     []string
	lookupErr error
	dnsChoice string

	hostsEntry   bool
	hostsDecided bool
}

type classifyTickMsg struct{ seq int }

type classifyMsg struct {
	seq    int
	result dnsclass.Result
}

type dnsCheckMsg struct {
	gen      int
	class    dnsclass.Result
	resolved bool
	addrs    []string
	err      error
}

func newNetwork(s *shared) *networkScreen { return &networkScreen{s: s} }

func (n *networkScreen) Title() string { return "Network & name" }

func (n *networkScreen) Help() string {
	switch n.step {
	case netHost, netSubnets:
		return "enter next · esc back · ctrl+c quit"
	case netDNS:
		if n.resolved {
			return "enter next · esc back · ctrl+c quit"
		}
		return "↑/↓ choose · enter confirm · esc back · ctrl+c quit"
	}
	return "↑/↓ choose · enter next · esc back · ctrl+c quit"
}

func (n *networkScreen) Init() tea.Cmd {
	c := n.s.cfg
	if n.s.deps.Interfaces != nil {
		n.ifaces = n.s.deps.Interfaces()
	}
	n.ifaceIdx = 0
	for i, f := range n.ifaces {
		if f.IP == strings.Trim(c.CaddyBindIP, "[]") {
			n.ifaceIdx = i
		}
	}
	n.host = c.AchillesDomain
	if n.subnets == "" {
		n.subnets = c.LANSubnets
	}
	return n.toIface()
}

func (n *networkScreen) iface() sysprobe.Iface {
	if n.ifaceIdx >= 0 && n.ifaceIdx < len(n.ifaces) {
		return n.ifaces[n.ifaceIdx]
	}
	return sysprobe.Iface{}
}

func (n *networkScreen) toIface() tea.Cmd {
	n.step = netIface
	if len(n.ifaces) == 0 {
		n.form = nil
		return nil
	}
	opts := make([]huh.Option[int], len(n.ifaces))
	for i, f := range n.ifaces {
		label := fmt.Sprintf("%-10s %-15s %s", f.Name, f.IP, f.CIDR)
		if f.Default {
			label += "  (default route)"
		}
		opts[i] = huh.NewOption(label, i)
	}
	var cmd tea.Cmd
	n.form, cmd = n.s.newForm(huh.NewGroup(
		huh.NewSelect[int]().
			Title("Which interface should ProjectAchilles listen on?").
			Description("Caddy publishes 80/443 on this address only.").
			Options(opts...).
			Value(&n.ifaceIdx),
	))
	return cmd
}

func (n *networkScreen) toHost() tea.Cmd {
	n.step = netHost
	var cmd tea.Cmd
	n.form, cmd = n.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Server hostname").
			Description("The name browsers and agents use, e.g. achilles.corp.example.com.").
			Placeholder("achilles.corp.example.com").
			Value(&n.host).
			Validate(func(v string) error {
				_, err := dnsclass.Normalize(v)
				return err
			}),
	))
	n.lastTyped = n.host
	if strings.TrimSpace(n.host) != "" && (n.class == nil || n.class.Host != strings.ToLower(strings.TrimSpace(n.host))) {
		n.seq++
		return tea.Batch(cmd, n.classify(n.seq, n.host))
	}
	return cmd
}

func (n *networkScreen) classify(seq int, host string) tea.Cmd {
	r := n.s.deps.Resolver
	return func() tea.Msg {
		return classifyMsg{seq: seq, result: dnsclass.Classify(context.Background(), host, r)}
	}
}

func (n *networkScreen) toChecking() tea.Cmd {
	n.step = netChecking
	n.form = nil
	n.gen++
	gen, host, ip, r := n.gen, n.host, n.iface().IP, n.s.deps.Resolver
	cached := n.class
	return func() tea.Msg {
		ctx := context.Background()
		var class dnsclass.Result
		if cached != nil && cached.Host == host {
			class = *cached
		} else {
			class = dnsclass.Classify(ctx, host, r)
		}
		ok, addrs, err := dnsclass.ResolvesTo(ctx, host, ip, r)
		return dnsCheckMsg{gen: gen, class: class, resolved: ok, addrs: addrs, err: err}
	}
}

func (n *networkScreen) toDNS(m dnsCheckMsg) tea.Cmd {
	n.step = netDNS
	n.class = &m.class
	n.resolved, n.addrs, n.lookupErr = m.resolved, m.addrs, m.err
	n.form = nil
	if n.resolved {
		n.hostsDecided = false // keep whatever HOSTS_ENTRY the config already has
		return nil
	}
	n.dnsChoice = "recheck"
	var cmd tea.Cmd
	n.form, cmd = n.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("How do you want to continue?").
			Options(
				huh.NewOption("Re-check DNS (after the record is created)", "recheck"),
				huh.NewOption("Add an /etc/hosts entry on this server and continue", "hosts"),
				huh.NewOption("Continue without a record for now", "skip"),
			).
			Value(&n.dnsChoice),
	))
	return cmd
}

func (n *networkScreen) toSubnets() tea.Cmd {
	n.step = netSubnets
	if cidr := n.iface().CIDR; n.subnets == "" || n.subnets == n.autoNet {
		n.subnets, n.autoNet = cidr, cidr
	}
	var cmd tea.Cmd
	n.form, cmd = n.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("LAN subnets allowed to reach HTTPS").
			Description("Comma-separated CIDRs. Used only if ufw or firewalld is already active: the installer never enables a firewall or touches port 22.").
			Value(&n.subnets).
			Validate(func(v string) error {
				_, err := parseSubnets(v)
				return err
			}),
	))
	return cmd
}

// parseSubnets validates a comma-separated CIDR list and returns it
// normalised (network address, no spaces, duplicates dropped).
func parseSubnets(v string) (string, error) {
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return "", fmt.Errorf("%q is not a CIDR such as 10.0.5.0/24", part)
		}
		s := p.Masked().String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return "", errors.New("enter at least one subnet, e.g. 10.0.5.0/24")
	}
	return strings.Join(out, ","), nil
}

func (n *networkScreen) Back() (bool, tea.Cmd) {
	switch n.step {
	case netHost:
		return true, n.toIface()
	case netChecking, netDNS:
		n.gen++ // drop an in-flight check
		return true, n.toHost()
	case netSubnets:
		if n.resolved {
			return true, n.toHost()
		}
		return true, n.toDNS(dnsCheckMsg{class: *n.class, resolved: n.resolved, addrs: n.addrs, err: n.lookupErr})
	}
	return false, nil
}

func (n *networkScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case classifyTickMsg:
		if msg.seq == n.seq && n.step == netHost {
			return n, n.classify(msg.seq, n.host)
		}
		return n, nil
	case classifyMsg:
		if msg.seq == n.seq {
			r := msg.result
			n.class = &r
		}
		return n, nil
	case dnsCheckMsg:
		if msg.gen == n.gen && n.step == netChecking {
			return n, n.toDNS(msg)
		}
		return n, nil
	case tea.KeyPressMsg:
		if msg.String() == "enter" {
			if n.step == netIface && len(n.ifaces) == 0 {
				return n, nil
			}
			if n.step == netDNS && n.resolved {
				return n, n.toSubnets()
			}
		}
	}

	completed, cmd := updateForm(n.form, msg)
	if n.step == netHost && n.host != n.lastTyped {
		n.lastTyped = n.host
		n.seq++
		seq := n.seq
		if strings.TrimSpace(n.host) == "" {
			n.class = nil
		} else {
			cmd = tea.Batch(cmd, tea.Tick(classifyDebounce, func(time.Time) tea.Msg { return classifyTickMsg{seq: seq} }))
		}
	}
	if !completed {
		return n, cmd
	}
	switch n.step {
	case netIface:
		return n, tea.Batch(cmd, n.toHost())
	case netHost:
		h, _ := dnsclass.Normalize(n.host) // validated by the field
		n.host = h
		return n, tea.Batch(cmd, n.toChecking())
	case netDNS:
		switch n.dnsChoice {
		case "hosts":
			n.hostsEntry, n.hostsDecided = true, true
		case "skip":
			n.hostsEntry, n.hostsDecided = false, true
		default:
			return n, tea.Batch(cmd, n.toChecking())
		}
		return n, tea.Batch(cmd, n.toSubnets())
	case netSubnets:
		n.subnets, _ = parseSubnets(n.subnets)
		return n, tea.Batch(cmd, done(n))
	}
	return n, cmd
}

func (n *networkScreen) View() tea.View {
	t := n.s.theme
	w := n.s.width
	var b strings.Builder
	switch n.step {
	case netIface:
		if len(n.ifaces) == 0 {
			b.WriteString(t.bad(wrap("No LAN IPv4 address found on this server (loopback, Docker and VPN interfaces are ignored). Connect it to the LAN and run the installer again.", w-2)))
			break
		}
		b.WriteString(n.form.View())
	case netHost:
		b.WriteString(n.form.View() + "\n\n")
		b.WriteString(n.classView())
	case netChecking:
		fmt.Fprintf(&b, "Checking whether %s resolves to %s on this server…", t.Strong.Render(n.host), n.iface().IP)
	case netDNS:
		b.WriteString(n.dnsView())
	case netSubnets:
		ip := n.iface().IP
		b.WriteString(t.Muted.Render(fmt.Sprintf("Listening on %s (%s) as %s", ip, n.iface().Name, n.host)) + "\n\n")
		b.WriteString(n.form.View())
	}
	return tea.NewView(b.String())
}

// classView is the live DNS-situation panel under the hostname field.
func (n *networkScreen) classView() string {
	t := n.s.theme
	w := n.s.width - 2
	if strings.TrimSpace(n.host) == "" {
		return t.Muted.Render("Type the full name; its DNS situation is checked as you type.")
	}
	c := n.class
	if c == nil || c.Host != strings.ToLower(strings.TrimSuffix(strings.TrimSpace(n.host), ".")) {
		return t.Muted.Render("… checking the DNS situation")
	}
	var lines []string
	switch {
	case c.Registrable == "":
		lines = append(lines, t.bad(wrap(c.Reason, w)))
	case c.Kind == dnsclass.PublicDomain:
		lines = append(lines,
			t.ok(wrap("Under a public domain: "+c.Reason+".", w)),
			"  "+t.Muted.Render(hang(wrap("Clerk: use production keys (pk_live_) and add the records Clerk lists to your public zone. Let's Encrypt DNS-01 is available.", w))))
	default:
		lines = append(lines,
			t.warn(wrap("Private-only name: "+c.Reason+".", w)),
			"  "+t.Muted.Render(hang(wrap("Clerk: development keys only (pk_test_), which show a development banner. A name under a domain you own avoids this.", w))))
	}
	for _, warning := range c.Warnings {
		lines = append(lines, t.warn(wrap(warning, w)))
	}
	return strings.Join(lines, "\n")
}

// dnsView shows the resolution result and, on a mismatch, the record to
// create (generic and AD DNS) plus the ways forward.
func (n *networkScreen) dnsView() string {
	t := n.s.theme
	w := n.s.width - 2
	ip := n.iface().IP
	var b strings.Builder
	if n.resolved {
		b.WriteString(t.ok(wrap(fmt.Sprintf("%s resolves to %s on this server.", n.host, ip), w)) + "\n\n")
		b.WriteString(t.Strong.Render("Press enter to continue."))
		return b.String()
	}
	switch {
	case n.lookupErr != nil:
		b.WriteString(t.warn(wrap(fmt.Sprintf("Could not check DNS for %s: %v", n.host, n.lookupErr), w)))
	case len(n.addrs) > 0:
		b.WriteString(t.warn(wrap(fmt.Sprintf("%s does not resolve to %s on this server (it resolves to %s).", n.host, ip, strings.Join(n.addrs, ", ")), w)))
	default:
		b.WriteString(t.warn(wrap(fmt.Sprintf("%s does not resolve on this server yet.", n.host), w)))
	}
	b.WriteString("\n\nCreate this record in your internal DNS:\n")
	b.WriteString("  " + t.Code.Render(fmt.Sprintf("%s.  A  %s", n.host, ip)) + "\n")
	b.WriteString("On Active Directory DNS (PowerShell on a DNS server):\n")
	for _, l := range adRecordCommand(n.host, ip, w-2) {
		b.WriteString("  " + t.Code.Render(l) + "\n")
	}
	b.WriteString("\n" + n.form.View())
	return b.String()
}

// adRecordCommand is the Add-DnsServerResourceRecordA line for host, using
// its parent as the zone. It is split with a PowerShell line continuation
// when it is wider than width, so it still pastes as one command.
func adRecordCommand(host, ip string, width int) []string {
	label, zone, ok := strings.Cut(host, ".")
	if !ok {
		zone = host
	}
	first := fmt.Sprintf(`Add-DnsServerResourceRecordA -ZoneName "%s"`, zone)
	rest := fmt.Sprintf(`-Name "%s" -IPv4Address "%s"`, label, ip)
	if one := first + " " + rest; lipgloss.Width(one) <= width {
		return []string{one}
	}
	return []string{first + " `", "  " + rest}
}

// Apply records the bind IP, hostname, subnets and (when the admin chose on
// a DNS mismatch) the hosts-entry flag.
func (n *networkScreen) Apply(c *config.Config) {
	f := n.iface()
	c.CaddyBindIP = f.IP
	c.AchillesDomain = n.host
	c.LANSubnets = n.subnets
	if n.hostsDecided {
		c.HostsEntry = n.hostsEntry
	}
	n.s.iface = f
	if n.class != nil {
		n.s.class = *n.class
	}
}

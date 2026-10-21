package sysprobe

import (
	"net"
	"reflect"
	"strings"
	"testing"
)

func TestLANInterfacesFiltersVirtual(t *testing.T) {
	up := net.FlagUp | net.FlagBroadcast
	ifs := []net.Interface{
		{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
		{Name: "docker0", Flags: up},
		{Name: "br-1a2b", Flags: up},
		{Name: "veth9", Flags: up},
		{Name: "tailscale0", Flags: up},
		{Name: "eth1", Flags: up},
		{Name: "ens18", Flags: up},
		{Name: "ens19", Flags: up},
		{Name: "ens20", Flags: net.FlagBroadcast}, // down
	}
	mk := func(s string) net.Addr {
		ip, n, _ := net.ParseCIDR(s)
		n.IP = ip
		return n
	}
	by := map[string][]net.Addr{
		"lo":         {mk("127.0.0.1/8")},
		"docker0":    {mk("172.17.0.1/16")},
		"br-1a2b":    {mk("172.18.0.1/16")},
		"veth9":      {mk("10.9.9.9/24")},
		"tailscale0": {mk("100.64.0.1/10")},
		"eth1":       {mk("fe80::1/64")},
		"ens18":      {mk("10.0.5.20/24")},
		"ens19":      {mk("192.168.1.10/24")},
		"ens20":      {mk("10.1.1.1/24")},
	}
	got := LANInterfaces(
		func() ([]net.Interface, error) { return ifs, nil },
		func(i net.Interface) ([]net.Addr, error) { return by[i.Name], nil },
		"ens19")
	want := []Iface{
		{"ens19", "192.168.1.10", "192.168.1.0/24", true},
		{"ens18", "10.0.5.20", "10.0.5.0/24", false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestParseDefaultRoute(t *testing.T) {
	in := `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask	MTU	Window	IRTT
wlan0	00000000	0101A8C0	0003	0	0	600	00000000	0	0	0
eth0	00000000	0105000A	0003	0	0	100	00000000	0	0	0
eth0	0005000A	00000000	0001	0	0	100	00FFFFFF	0	0	0
`
	if got := ParseDefaultRoute(strings.NewReader(in)); got != "eth0" {
		t.Errorf("got %q", got)
	}
	if got := ParseDefaultRoute(strings.NewReader("Iface\n")); got != "" {
		t.Errorf("got %q", got)
	}
}

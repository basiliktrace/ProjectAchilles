package sysprobe

import (
	"bufio"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Iface is one LAN-bindable IPv4 address.
type Iface struct {
	Name, IP, CIDR string
	Default        bool
}

var virtualPrefixes = []string{
	"docker", "br-", "veth", "virbr", "tailscale", "tun", "wg", "zt", "cni", "flannel", "cali", "vxlan",
}

func isVirtual(name string) bool {
	for _, p := range virtualPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// LANInterfaces lists candidate LAN IPv4 addresses, default-route interface
// first, then by name (and IP).
func LANInterfaces(list func() ([]net.Interface, error), addrs func(net.Interface) ([]net.Addr, error), defaultIface string) []Iface {
	ifs, err := list()
	if err != nil {
		return nil
	}
	out := []Iface{}
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagLoopback != 0 || ifc.Flags&net.FlagUp == 0 || isVirtual(ifc.Name) {
			continue
		}
		as, err := addrs(ifc)
		if err != nil {
			continue
		}
		for _, a := range as {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 == nil {
				continue
			}
			network := &net.IPNet{IP: ip4.Mask(ipn.Mask), Mask: ipn.Mask}
			out = append(out, Iface{
				Name:    ifc.Name,
				IP:      ip4.String(),
				CIDR:    network.String(),
				Default: ifc.Name == defaultIface,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Default != out[j].Default {
			return out[i].Default
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].IP < out[j].IP
	})
	return out
}

// SystemLANInterfaces is LANInterfaces over the real host.
func SystemLANInterfaces() []Iface {
	return LANInterfaces(net.Interfaces, func(i net.Interface) ([]net.Addr, error) { return i.Addrs() }, DefaultRouteIface())
}

// ParseDefaultRoute returns the interface of the default route (destination
// 00000000) with the lowest metric from /proc/net/route content, or "".
func ParseDefaultRoute(r io.Reader) string {
	best, bestMetric := "", -1
	sc := bufio.NewScanner(r)
	sc.Scan() // header
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 7 || f[1] != "00000000" {
			continue
		}
		m, err := strconv.Atoi(f[6])
		if err != nil {
			continue
		}
		if bestMetric < 0 || m < bestMetric {
			best, bestMetric = f[0], m
		}
	}
	return best
}

// DefaultRouteIface reads /proc/net/route; "" if unavailable.
func DefaultRouteIface() string {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return ""
	}
	defer f.Close()
	return ParseDefaultRoute(f)
}

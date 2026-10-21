package dnsclass

import (
	"context"
	"errors"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeResolver struct {
	ns      func(ctx context.Context, name string) ([]*net.NS, error)
	host    func(ctx context.Context, host string) ([]string, error)
	nsCalls []string
}

func (f *fakeResolver) LookupNS(ctx context.Context, name string) ([]*net.NS, error) {
	f.nsCalls = append(f.nsCalls, name)
	return f.ns(ctx, name)
}

func (f *fakeResolver) LookupHost(ctx context.Context, host string) ([]string, error) {
	return f.host(ctx, host)
}

func nxdomain(name string) error {
	return &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
}

func TestNormalize(t *testing.T) {
	long := strings.Repeat("a", 64)
	tooLong := strings.Repeat("abcdefgh.", 31) + "com" // > 253
	tests := []struct {
		in, want string
		wantErr  bool
	}{
		{"  Achilles.Corp.Example.COM. ", "achilles.corp.example.com", false},
		{"achilles.corp.lan", "achilles.corp.lan", false},
		{"10.0.5.20", "", true},
		{"::1", "", true},
		{"achilles", "", true},
		{"", "", true},
		{"bad_label.example.com", "", true},
		{"-bad.example.com", "", true},
		{"bad-.example.com", "", true},
		{"a..example.com", "", true},
		{long + ".example.com", "", true},
		{tooLong, "", true},
		{"a.b..", "", true},
	}
	for _, tc := range tests {
		got, err := Normalize(tc.in)
		if (err != nil) != tc.wantErr {
			t.Errorf("Normalize(%q) err=%v wantErr=%v", tc.in, err, tc.wantErr)
		}
		if got != tc.want {
			t.Errorf("Normalize(%q)=%q want %q", tc.in, got, tc.want)
		}
	}
}

func TestClassifySpecialTLDs(t *testing.T) {
	for _, h := range []string{"a.corp.lan", "a.b.internal", "a.home.arpa", "x.intranet", "x.corp", "x.localdomain"} {
		r := &fakeResolver{ns: func(context.Context, string) ([]*net.NS, error) {
			t.Errorf("no lookup expected for %s", h)
			return nil, nil
		}}
		res := Classify(context.Background(), h, r)
		if res.Kind != PrivateOnly {
			t.Errorf("%s: kind=%v want PrivateOnly", h, res.Kind)
		}
		if res.Reason == "" || len(res.ZoneCandidates) == 0 {
			t.Errorf("%s: missing reason/zones: %+v", h, res)
		}
	}
}

func TestClassifyLocalWarnsMDNS(t *testing.T) {
	res := Classify(context.Background(), "achilles.local", &fakeResolver{})
	if res.Kind != PrivateOnly {
		t.Fatalf("kind=%v", res.Kind)
	}
	found := false
	for _, w := range res.Warnings {
		if strings.Contains(w, "mDNS") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected mDNS warning, got %v", res.Warnings)
	}
}

func TestClassifyPublicDomainWithNS(t *testing.T) {
	r := &fakeResolver{ns: func(_ context.Context, name string) ([]*net.NS, error) {
		return []*net.NS{{Host: "ns1.example.com."}}, nil
	}}
	res := Classify(context.Background(), "Achilles.Corp.Example.com.", r)
	if res.Kind != PublicDomain {
		t.Fatalf("kind=%v", res.Kind)
	}
	if res.Host != "achilles.corp.example.com" || res.Registrable != "example.com" {
		t.Errorf("host/registrable: %+v", res)
	}
	if len(r.nsCalls) != 1 || r.nsCalls[0] != "example.com" {
		t.Errorf("nsCalls=%v", r.nsCalls)
	}
}

func TestClassifyNXDomainIsPrivate(t *testing.T) {
	r := &fakeResolver{ns: func(_ context.Context, name string) ([]*net.NS, error) {
		return nil, nxdomain(name)
	}}
	res := Classify(context.Background(), "achilles.nonexistent-zzz.com", r)
	if res.Kind != PrivateOnly {
		t.Fatalf("kind=%v", res.Kind)
	}
	for _, w := range res.Warnings {
		if strings.Contains(w, "could not reach public DNS") {
			t.Errorf("NXDOMAIN must not warn about reachability: %v", res.Warnings)
		}
	}
}

func TestClassifyTimeoutFallsBackPrivateWithWarning(t *testing.T) {
	r := &fakeResolver{ns: func(ctx context.Context, _ string) ([]*net.NS, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	start := time.Now()
	res := Classify(context.Background(), "achilles.example.com", r)
	if d := time.Since(start); d > 4*time.Second {
		t.Fatalf("took %v", d)
	}
	if res.Kind != PrivateOnly {
		t.Errorf("kind=%v", res.Kind)
	}
	if !strings.Contains(strings.Join(res.Warnings, "|"), "could not reach public DNS") {
		t.Errorf("warnings=%v", res.Warnings)
	}
}

func TestClassifyHonoursCallerContext(t *testing.T) {
	r := &fakeResolver{ns: func(ctx context.Context, _ string) ([]*net.NS, error) {
		<-ctx.Done()
		return nil, errors.New("canceled")
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	res := Classify(ctx, "achilles.example.com", r)
	if time.Since(start) > time.Second {
		t.Fatal("did not honour caller ctx")
	}
	if res.Kind != PrivateOnly {
		t.Errorf("kind=%v", res.Kind)
	}
}

func TestClassifyInvalidHost(t *testing.T) {
	res := Classify(context.Background(), "10.0.0.1", &fakeResolver{})
	if res.Kind != PrivateOnly || res.Reason == "" {
		t.Errorf("%+v", res)
	}
}

func TestZoneCandidates(t *testing.T) {
	nsOK := func(context.Context, string) ([]*net.NS, error) { return []*net.NS{{Host: "ns."}}, nil }
	tests := []struct {
		host, registrable string
		want              []string
	}{
		{"achilles.corp.example.com", "example.com", []string{"corp.example.com", "example.com"}},
		{"achilles.example.com", "example.com", []string{"example.com"}},
		{"example.com", "example.com", []string{"example.com"}},
		{"a.b.example.co.uk", "example.co.uk", []string{"b.example.co.uk", "example.co.uk"}},
		{"a.b.corp.lan", "corp.lan", []string{"b.corp.lan", "corp.lan"}},
		{"achilles.corp.lan", "corp.lan", []string{"corp.lan"}},
		{"corp.lan", "corp.lan", []string{"corp.lan"}},
	}
	for _, tc := range tests {
		res := Classify(context.Background(), tc.host, &fakeResolver{ns: nsOK})
		if res.Registrable != tc.registrable {
			t.Errorf("%s: registrable=%q want %q", tc.host, res.Registrable, tc.registrable)
		}
		if !reflect.DeepEqual(res.ZoneCandidates, tc.want) {
			t.Errorf("%s: zones=%v want %v", tc.host, res.ZoneCandidates, tc.want)
		}
	}
}

func TestResolvesTo(t *testing.T) {
	r := &fakeResolver{host: func(_ context.Context, h string) ([]string, error) {
		switch h {
		case "match.example.com":
			return []string{"10.0.0.9", "10.0.5.20"}, nil
		case "other.example.com":
			return []string{"10.0.0.9"}, nil
		}
		return nil, nxdomain(h)
	}}
	ok, addrs, err := ResolvesTo(context.Background(), "match.example.com", "10.0.5.20", r)
	if err != nil || !ok || len(addrs) != 2 {
		t.Errorf("match: %v %v %v", ok, addrs, err)
	}
	ok, addrs, err = ResolvesTo(context.Background(), "other.example.com", "10.0.5.20", r)
	if err != nil || ok || !reflect.DeepEqual(addrs, []string{"10.0.0.9"}) {
		t.Errorf("mismatch: %v %v %v", ok, addrs, err)
	}
	ok, addrs, err = ResolvesTo(context.Background(), "gone.example.com", "10.0.5.20", r)
	if err != nil || ok || len(addrs) != 0 {
		t.Errorf("nxdomain: %v %v %v", ok, addrs, err)
	}
	boom := &fakeResolver{host: func(context.Context, string) ([]string, error) { return nil, errors.New("boom") }}
	if _, _, err := ResolvesTo(context.Background(), "x.example.com", "10.0.5.20", boom); err == nil {
		t.Error("expected error for non-NXDOMAIN failure")
	}
}

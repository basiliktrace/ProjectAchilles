package clerkadmin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const signUp = "https://achilles.example.com/sign-up"

// fakeClerk is the slice of the Clerk Backend API the installer uses.
type fakeClerk struct {
	users       string // GET /users response body
	invitations string // GET /invitations response body
	writes      []string
	bodies      []map[string]any
	auth        string
	failWrite   int
}

func (f *fakeClerk) server(t *testing.T) Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.auth = r.Header.Get("Authorization")
		switch {
		case r.Method == "GET" && r.URL.Path == "/users":
			if r.URL.Query().Get("email_address") != "admin@example.com" {
				t.Errorf("users query = %q", r.URL.RawQuery)
			}
			io.WriteString(w, f.users)
		case r.Method == "GET" && r.URL.Path == "/invitations":
			if q := r.URL.Query(); q.Get("status") != "pending" || q.Get("query") != "admin@example.com" {
				t.Errorf("invitations query = %q", r.URL.RawQuery)
			}
			io.WriteString(w, f.invitations)
		default:
			f.writes = append(f.writes, r.Method+" "+r.URL.Path)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.bodies = append(f.bodies, body)
			if f.failWrite != 0 {
				w.WriteHeader(f.failWrite)
				io.WriteString(w, `{"errors":[{"message":"bad","long_message":"Redirect URL is not allowed","code":"x"}]}`)
				return
			}
			io.WriteString(w, `{"id":"x"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return Client{BaseURL: srv.URL, SecretKey: "sk_test_abc", HTTP: srv.Client()}
}

func TestInvitesWhenNoUserOrInvitation(t *testing.T) {
	f := &fakeClerk{users: `[]`, invitations: `[]`} // the documented shape: a plain array
	r, err := f.server(t).EnsureAdmin(context.Background(), "admin@example.com", signUp)
	if err != nil || r.Outcome != Invited {
		t.Fatalf("got %+v, %v", r, err)
	}
	if f.auth != "Bearer sk_test_abc" {
		t.Errorf("auth header %q", f.auth)
	}
	if len(f.writes) != 1 || f.writes[0] != "POST /invitations" {
		t.Fatalf("writes %v", f.writes)
	}
	b := f.bodies[0]
	if b["email_address"] != "admin@example.com" || b["redirect_url"] != signUp || b["notify"] != true || b["ignore_existing"] != true {
		t.Errorf("body %v", b)
	}
	if md, _ := b["public_metadata"].(map[string]any); md["role"] != "admin" {
		t.Errorf("public_metadata %v", b["public_metadata"])
	}
}

func TestPromotesExistingUserByMergingRole(t *testing.T) {
	f := &fakeClerk{users: `[{"id":"user_1","public_metadata":{"org_id":"o1"}}]`}
	r, err := f.server(t).EnsureAdmin(context.Background(), "admin@example.com", signUp)
	if err != nil || r.Outcome != Promoted {
		t.Fatalf("got %+v, %v", r, err)
	}
	if len(f.writes) != 1 || f.writes[0] != "PATCH /users/user_1/metadata" {
		t.Fatalf("writes %v", f.writes)
	}
	// Clerk deep-merges, so only the role is sent: org_id stays.
	md, _ := f.bodies[0]["public_metadata"].(map[string]any)
	if len(md) != 1 || md["role"] != "admin" {
		t.Errorf("public_metadata %v", f.bodies[0])
	}
}

func TestExistingAdminIsLeftAlone(t *testing.T) {
	f := &fakeClerk{users: `[{"id":"user_1","public_metadata":{"role":"admin"}}]`}
	r, err := f.server(t).EnsureAdmin(context.Background(), "admin@example.com", signUp)
	if err != nil || r.Outcome != AlreadyAdmin || len(f.writes) != 0 {
		t.Fatalf("got %+v, %v, writes %v", r, err, f.writes)
	}
}

// A re-run (Reconfigure) must not send the invitation email again.
func TestPendingAdminInvitationIsNotResent(t *testing.T) {
	f := &fakeClerk{users: `[]`, invitations: `{"data":[{"email_address":"Admin@Example.com","public_metadata":{"role":"admin"}}],"total_count":1}`}
	r, err := f.server(t).EnsureAdmin(context.Background(), "admin@example.com", signUp)
	if err != nil || r.Outcome != AlreadyInvited || len(f.writes) != 0 {
		t.Fatalf("got %+v, %v, writes %v", r, err, f.writes)
	}
}

// An older pending invitation without the admin role is revoked first: left
// valid next to the new one, accepting it would create an account with no role.
func TestPendingInvitationWithoutAdminRoleIsReplaced(t *testing.T) {
	f := &fakeClerk{users: `[]`, invitations: `[{"id":"inv_old","email_address":"admin@example.com","public_metadata":{}},{"id":"inv_other","email_address":"someone@example.com","public_metadata":{}}]`}
	r, err := f.server(t).EnsureAdmin(context.Background(), "admin@example.com", signUp)
	if err != nil || r.Outcome != Invited {
		t.Fatalf("got %+v, %v", r, err)
	}
	if want := []string{"POST /invitations/inv_old/revoke", "POST /invitations"}; strings.Join(f.writes, ",") != strings.Join(want, ",") {
		t.Fatalf("writes %v, want %v", f.writes, want)
	}
}

func TestClerkErrorMessageIsReported(t *testing.T) {
	f := &fakeClerk{users: `[]`, invitations: `{"data":[]}`, failWrite: 422}
	_, err := f.server(t).EnsureAdmin(context.Background(), "admin@example.com", signUp)
	if err == nil || !strings.Contains(err.Error(), "Redirect URL is not allowed") || !strings.Contains(err.Error(), "422") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "sk_test_abc") {
		t.Fatal("error leaks the secret key")
	}
}

func TestResultMessage(t *testing.T) {
	for o, want := range map[Outcome]string{
		Invited:        "Invitation sent to admin@example.com",
		AlreadyInvited: "already has a pending invitation",
		Promoted:       "now an admin",
		AlreadyAdmin:   "already an admin",
	} {
		if got := (Result{Outcome: o, Email: "admin@example.com"}).Message(); !strings.Contains(got, want) {
			t.Errorf("%v: %q missing %q", o, got, want)
		}
	}
}

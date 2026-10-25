// Package clerkadmin gives the install's first admin the admin role through
// the Clerk Backend API: an invitation carrying role=admin, or, when the
// person already has an account, a merge of the role into its public
// metadata. Without it a new install has no one who can manage it.
package clerkadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
)

// DefaultBaseURL is the Clerk Backend API.
const DefaultBaseURL = "https://api.clerk.com/v1"

// Outcome is what EnsureAdmin did.
type Outcome int

const (
	Invited Outcome = iota
	AlreadyInvited
	Promoted
	AlreadyAdmin
)

// Result is EnsureAdmin's outcome for one email address.
type Result struct {
	Outcome Outcome
	Email   string
}

// Message is a one-line summary for the person running the installer.
func (r Result) Message() string {
	switch r.Outcome {
	case Invited:
		return "Invitation sent to " + r.Email + ": accept it from the email to create the admin account."
	case AlreadyInvited:
		return r.Email + " already has a pending invitation as admin: accept it from the email."
	case Promoted:
		return r.Email + " already had an account and is now an admin."
	default:
		return r.Email + " is already an admin."
	}
}

// Client calls the Clerk Backend API with an instance's secret key.
type Client struct {
	BaseURL   string
	SecretKey string
	HTTP      *http.Client
}

// New returns a client for the real Clerk API.
func New(secretKey string) Client {
	return Client{BaseURL: DefaultBaseURL, SecretKey: secretKey, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

type metadata map[string]any

func isAdmin(md metadata) bool { return md["role"] == "admin" }

// EnsureAdmin makes email an admin of the Clerk instance. An existing account
// gets role=admin merged into its public metadata; otherwise Clerk emails an
// invitation whose link opens signUpURL, and the account it creates carries
// role=admin. It changes nothing when the account is already an admin or an
// admin invitation is pending, so re-running an install doesn't resend email.
func (c Client) EnsureAdmin(ctx context.Context, email, signUpURL string) (Result, error) {
	res := Result{Email: email}

	var users []struct {
		ID             string   `json:"id"`
		PublicMetadata metadata `json:"public_metadata"`
	}
	if err := c.do(ctx, "GET", "/users?"+url.Values{"email_address": {email}}.Encode(), nil, &users); err != nil {
		return res, err
	}
	if len(users) > 0 {
		if isAdmin(users[0].PublicMetadata) {
			res.Outcome = AlreadyAdmin
			return res, nil
		}
		// Clerk deep-merges: only the role is sent, the rest (org_id) stays.
		body := map[string]any{"public_metadata": metadata{"role": "admin"}}
		res.Outcome = Promoted
		return res, c.do(ctx, "PATCH", "/users/"+url.PathEscape(users[0].ID)+"/metadata", body, nil)
	}

	var pending invitationList
	if err := c.do(ctx, "GET", "/invitations?"+url.Values{"status": {"pending"}, "query": {email}}.Encode(), nil, &pending); err != nil {
		return res, err
	}
	for _, inv := range pending.items {
		if strings.EqualFold(inv.EmailAddress, email) && isAdmin(inv.PublicMetadata) {
			res.Outcome = AlreadyInvited
			return res, nil
		}
	}

	body := map[string]any{
		"email_address":   email,
		"public_metadata": metadata{"role": "admin"},
		"redirect_url":    signUpURL,
		"notify":          true,
		"ignore_existing": true, // a pending invitation without the admin role
	}
	res.Outcome = Invited
	return res, c.do(ctx, "POST", "/invitations", body, nil)
}

type invitation struct {
	EmailAddress   string   `json:"email_address"`
	PublicMetadata metadata `json:"public_metadata"`
}

// invitationList accepts the documented array and the paginated
// {"data": [...]} shape some API versions return.
type invitationList struct{ items []invitation }

func (l *invitationList) UnmarshalJSON(b []byte) error {
	if bytes.HasPrefix(bytes.TrimSpace(b), []byte("[")) {
		return json.Unmarshal(b, &l.items)
	}
	var page struct {
		Data []invitation `json:"data"`
	}
	err := json.Unmarshal(b, &page)
	l.items = page.Data
	return err
}

// do sends one request; a non-2xx status becomes an error with Clerk's message.
func (c Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.SecretKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("Clerk API: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Clerk API %s %s: HTTP %d: %s", method, strings.SplitN(path, "?", 2)[0], resp.StatusCode, clerkError(data))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// clerkError is the first error message in a Clerk error response.
func clerkError(data []byte) string {
	var e struct {
		Errors []struct {
			Message     string `json:"message"`
			LongMessage string `json:"long_message"`
		} `json:"errors"`
	}
	if json.Unmarshal(data, &e) == nil && len(e.Errors) > 0 {
		if m := e.Errors[0].LongMessage; m != "" {
			return m
		}
		return e.Errors[0].Message
	}
	return strings.TrimSpace(string(data))
}

// SignUpURL is the app's sign-up page, where an invitation link lands.
func SignUpURL(domain string) string { return "https://" + domain + "/sign-up" }

// ManualSteps says how to make the first admin by hand, for when the
// installer could not (or was given no ADMIN_EMAIL).
func ManualSteps(domain string) string {
	return "Sign up at " + SignUpURL(domain) + `, then in the Clerk dashboard (Users → the user → Metadata) set Public metadata to {"role": "admin"}.`
}

// ForConfig makes the install's ADMIN_EMAIL an admin with its Clerk secret key.
func ForConfig(ctx context.Context, c config.Config) (Result, error) {
	return New(c.ClerkSecretKey).EnsureAdmin(ctx, c.AdminEmail, SignUpURL(c.AchillesDomain))
}

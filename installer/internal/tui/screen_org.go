package tui

import (
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
)

// orgNameMax is ORGANIZATION_NAME's cap (the execution report's header width).
const orgNameMax = 56

// Defaults matching deploy.config.env.example.
const (
	defaultTestsRepo   = "https://github.com/ubercylon8/f0_library.git"
	defaultTestsBranch = "main"
	defaultAgentRepo   = "https://github.com/projectachilles/ProjectAchilles.git"
)

// orgScreen collects the organisation name and the test-library source.
type orgScreen struct {
	s    *shared
	form *huh.Form

	name, repo, branch, token string
	// nameLen mirrors len(name) for the counter. Huh evaluates
	// DescriptionFunc on a command goroutine, so the counter must not read
	// name itself (the event loop writes it). The command starts after
	// Update returns, so it sees the latest store.
	nameLen atomic.Int64
}

func newOrg(s *shared) *orgScreen { return &orgScreen{s: s} }

func (o *orgScreen) Title() string { return "Organisation" }

func (o *orgScreen) Help() string {
	return "enter next field · shift+tab previous · esc back · ctrl+c quit"
}

func (o *orgScreen) Init() tea.Cmd {
	c := o.s.cfg
	o.name, o.token = c.OrganizationName, c.GithubToken
	o.syncLen()
	o.repo, o.branch = orDefault(c.TestsRepoURL, defaultTestsRepo), orDefault(c.TestsRepoBranch, defaultTestsBranch)
	noSpace := func(what string) func(string) error {
		return func(v string) error {
			v = strings.TrimSpace(v)
			switch {
			case v == "":
				return errors.New(what + " is required")
			case strings.ContainsAny(v, " \t'\"\\"):
				return errors.New(what + " can't contain spaces, quotes or backslashes")
			}
			return nil
		}
	}
	var cmd tea.Cmd
	o.form, cmd = o.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Organisation name").
			DescriptionFunc(o.counter, &o.name).
			Placeholder("optional, e.g. Acme Corp").
			Value(&o.name).
			Validate(func(v string) error {
				if n := utf8.RuneCountInString(strings.TrimSpace(v)); n > orgNameMax {
					return fmt.Errorf("at most %d characters (this is %d)", orgNameMax, n)
				}
				return nil
			}),
		huh.NewInput().
			Title("Test library repository").
			Description("Git URL of the security test library (the public default needs no token).").
			Value(&o.repo).
			Validate(noSpace("the repository URL")),
		huh.NewInput().
			Title("Test library branch").
			Value(&o.branch).
			Validate(noSpace("the branch")),
		huh.NewInput().
			Title("GitHub token").
			Description("Only for a private repository (scope: repo). Leave blank otherwise.").
			EchoMode(huh.EchoModePassword).
			Value(&o.token),
	))
	return cmd
}

func (o *orgScreen) syncLen() {
	o.nameLen.Store(int64(utf8.RuneCountInString(strings.TrimSpace(o.name))))
}

// counter is the organisation name's live length note.
func (o *orgScreen) counter() string {
	n := int(o.nameLen.Load())
	s := fmt.Sprintf("Printed on execution reports. %d / %d characters", n, orgNameMax)
	if n > orgNameMax {
		s += ": too long"
	}
	return s
}

func (o *orgScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	completed, cmd := updateForm(o.form, msg)
	o.syncLen()
	if completed {
		return o, tea.Batch(cmd, done(o))
	}
	return o, cmd
}

func (o *orgScreen) View() tea.View {
	return tea.NewView(o.form.View())
}

// Apply records the organisation and repositories. The agent source repo is
// not asked for (in-app agent builds use it); a blank one gets the default.
func (o *orgScreen) Apply(c *config.Config) {
	c.OrganizationName = strings.TrimSpace(o.name)
	c.TestsRepoURL = strings.TrimSpace(o.repo)
	c.TestsRepoBranch = strings.TrimSpace(o.branch)
	c.GithubToken = strings.TrimSpace(o.token)
	if c.AgentRepoURL == "" {
		c.AgentRepoURL = defaultAgentRepo
	}
	if c.AgentRepoBranch == "" {
		c.AgentRepoBranch = defaultTestsBranch
	}
}

func orDefault(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

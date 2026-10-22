package tui

import (
	"errors"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
)

type esStep int

const (
	esMode  esStep = iota // self-hosted or Elastic Cloud
	esCloud               // Cloud ID + API key
	esSeed                // self-hosted: synthetic demo data?
)

// analyticsScreen picks where Elasticsearch runs. Self-hosted is only
// offered when the preflight memory check passed (>= 4 GiB).
type analyticsScreen struct {
	s    *shared
	step esStep
	form *huh.Form

	mode         string // self | cloud
	cloudID, key string
	seed         bool
	selfAllowed  bool
	selfReason   string // why self-hosted isn't offered
}

func newAnalytics(s *shared) *analyticsScreen { return &analyticsScreen{s: s} }

func (a *analyticsScreen) Title() string { return "Analytics" }

func (a *analyticsScreen) Help() string {
	switch a.step {
	case esCloud:
		return "enter next field · shift+tab previous · esc back · ctrl+c quit"
	case esSeed:
		return "←/→ choose · enter next · esc back · ctrl+c quit"
	}
	return "↑/↓ choose · enter next · esc back · ctrl+c quit"
}

func (a *analyticsScreen) Init() tea.Cmd {
	c := a.s.cfg
	a.selfAllowed = sysprobe.ESSelfAllowed(a.s.checks)
	a.selfReason = ""
	if !a.selfAllowed {
		a.selfReason = "the memory check did not pass"
		for _, ch := range a.s.checks {
			if ch.ID == "ram" && ch.Detail != "" {
				a.selfReason = ch.Detail
			}
		}
	}
	a.mode = c.ESMode
	if a.mode != "cloud" {
		a.mode = "self"
	}
	if !a.selfAllowed {
		a.mode = "cloud"
	}
	a.cloudID, a.key = c.ElasticsearchCloudID, c.ElasticsearchAPIKey
	a.seed = c.SeedES == "true"
	return a.toMode()
}

func (a *analyticsScreen) toMode() tea.Cmd {
	a.step = esMode
	var opts []huh.Option[string]
	if a.selfAllowed {
		opts = append(opts, huh.NewOption("Self-hosted on this server (an Elasticsearch container)", "self"))
	}
	opts = append(opts, huh.NewOption("Elastic Cloud (managed: you need a Cloud ID and an API key)", "cloud"))
	var cmd tea.Cmd
	a.form, cmd = a.s.newForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Where should Elasticsearch run?").
			Description("Test results and the analytics dashboards are stored there.").
			Options(opts...).
			Value(&a.mode),
	))
	return cmd
}

func (a *analyticsScreen) toCloud() tea.Cmd {
	a.step = esCloud
	required := func(what string) func(string) error {
		return func(v string) error {
			if strings.TrimSpace(v) == "" {
				return errors.New(what + " is required")
			}
			return nil
		}
	}
	var cmd tea.Cmd
	a.form, cmd = a.s.newForm(huh.NewGroup(
		huh.NewInput().
			Title("Elastic Cloud ID").
			Description("Elastic Cloud console → your deployment → Cloud ID.").
			Value(&a.cloudID).
			Validate(func(v string) error {
				if strings.TrimSpace(v) == "" {
					return errors.New("Cloud ID is required")
				}
				if !strings.Contains(v, ":") {
					return errors.New("a Cloud ID looks like name:base64…")
				}
				return nil
			}),
		huh.NewInput().
			Title("Elastic Cloud API key").
			Description("Needs read and write access to the achilles-* indices.").
			EchoMode(huh.EchoModePassword).
			Value(&a.key).
			Validate(required("API key")),
	))
	return cmd
}

func (a *analyticsScreen) toSeed() tea.Cmd {
	a.step = esSeed
	var cmd tea.Cmd
	a.form, cmd = a.s.newForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Load demo data?").
			Description("Seeds about 1000 synthetic test results so the dashboards have something to show. Leave it off for a production install.").
			Affirmative("Yes, seed").
			Negative("No").
			Value(&a.seed),
	))
	return cmd
}

func (a *analyticsScreen) Back() (bool, tea.Cmd) {
	if a.step != esMode {
		return true, a.toMode()
	}
	return false, nil
}

func (a *analyticsScreen) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	completed, cmd := updateForm(a.form, msg)
	if !completed {
		return a, cmd
	}
	switch a.step {
	case esMode:
		if a.mode == "cloud" {
			return a, tea.Batch(cmd, a.toCloud())
		}
		return a, tea.Batch(cmd, a.toSeed())
	default:
		return a, tea.Batch(cmd, done(a))
	}
}

func (a *analyticsScreen) View() tea.View {
	t := a.s.theme
	var b strings.Builder
	if a.step == esMode && !a.selfAllowed {
		b.WriteString(t.warn(wrap("Self-hosted Elasticsearch isn't available on this server: "+a.selfReason+". It needs at least 4 GiB of RAM.", a.s.width-2)) + "\n\n")
	}
	b.WriteString(a.form.View())
	return tea.NewView(b.String())
}

// Apply records ES_MODE and its settings. Cloud credentials are cleared for
// a self-hosted install so the file holds no unused secret; seeding only
// applies to the self-hosted container.
func (a *analyticsScreen) Apply(c *config.Config) {
	c.ESMode = a.mode
	if a.mode == "cloud" {
		c.ElasticsearchCloudID, c.ElasticsearchAPIKey = strings.TrimSpace(a.cloudID), strings.TrimSpace(a.key)
		c.SeedES = "false"
		return
	}
	c.ElasticsearchCloudID, c.ElasticsearchAPIKey = "", ""
	c.SeedES = "false"
	if a.seed {
		c.SeedES = "true"
	}
}

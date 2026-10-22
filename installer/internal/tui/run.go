package tui

import (
	"context"
	"errors"
	"io"
	"os"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/term"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
)

// ErrNotInteractive is returned by CheckInteractive. Its text points to the
// unattended form of the command.
var ErrNotInteractive = errors.New("this terminal can't run the interactive installer (stdin/stdout is not a TTY, or TERM=dumb). " +
	"For an unattended install, fill in deploy.config.env and run: achilles-installer install --config FILE --yes")

// CheckInteractive reports whether the wizard can run on in/out: both must be
// terminals and TERM must not be "dumb".
func CheckInteractive(in, out any, termName string) error {
	if termName == "dumb" {
		return ErrNotInteractive
	}
	for _, f := range []any{in, out} {
		file, ok := f.(*os.File)
		if !ok || !term.IsTerminal(file.Fd()) {
			return ErrNotInteractive
		}
	}
	return nil
}

// Run shows the wizard on in/out until it finishes. An engine run still
// going when the program ends (e.g. it was killed) is stopped before Run
// returns.
func Run(ctx context.Context, d Deps, existing *config.Config, in io.Reader, out io.Writer) (Outcome, error) {
	app := newApp(d, existing)
	defer app.Close()
	p := tea.NewProgram(app, tea.WithContext(ctx), tea.WithInput(in), tea.WithOutput(out))
	m, err := p.Run()
	if a, ok := m.(*App); ok {
		return a.Outcome(), err
	}
	return app.Outcome(), err
}

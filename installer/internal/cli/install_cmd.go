package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tui"
)

// defaultRepoDir is where install-onprem.sh clones ProjectAchilles.
const defaultRepoDir = "/opt/projectachilles"

// installIO is the install handler's view of the process.
type installIO struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	getenv         func(string) string
	// newRunner returns an engine run of scripts/deploy-server.sh in root
	// for cfgPath (absolute). Tests fake it.
	newRunner func(root, cfgPath, caDir string) (engine.Starter, error)
}

func init() {
	registerInstall(defaultRegistry, installIO{
		stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, getenv: os.Getenv,
		newRunner: engineRunner,
	})
}

// engineRunner is the real engine: deploy-server.sh driven by this binary.
// A non-default CA directory is passed on so the engine and the wizard
// agree on where the CA lives.
func engineRunner(root, cfgPath, caDir string) (engine.Starter, error) {
	bin, err := os.Executable()
	if err != nil {
		return nil, err
	}
	r := engine.Runner{RepoRoot: root, ConfigPath: cfgPath, InstallerBin: bin}
	if caDir != "" && caDir != defaultCADir {
		r.Env = append(r.Env, "ACHILLES_CA_DIR_OVERRIDE="+caDir)
	}
	return r, nil
}

func registerInstall(r *Registry, sio installIO) { r.Register("install", installCmd(r, sio)) }

// repoDir picks the checkout to install from: --repo, else the working
// directory when it is a checkout, else /opt/projectachilles.
func repoDir(flagVal string) string {
	if flagVal != "" {
		return flagVal
	}
	if wd, err := os.Getwd(); err == nil {
		if _, err := os.Stat(filepath.Join(wd, "scripts", "deploy-server.sh")); err == nil {
			return wd
		}
	}
	return defaultRepoDir
}

func installCmd(r *Registry, sio installIO) Handler {
	return func(ctx context.Context, args []string) error {
		flags := newFlagSet("install", sio.stderr)
		cfgFile := flags.String("config", "", "deploy.config.env to install from without prompts (with --yes)")
		yes := flags.Bool("yes", false, "run unattended: no wizard, no confirmation")
		repo := flags.String("repo", "", "ProjectAchilles checkout (default: the current directory if it is one, else "+defaultRepoDir+")")
		caDir := flags.String("ca-dir", defaultCADir, "where an existing ProjectAchilles CA lives")
		if err := parseFlags(flags, args); err != nil {
			return helpOK(err)
		}
		if *cfgFile != "" || *yes {
			return unattended(ctx, sio, repoDir(*repo), *cfgFile, *yes, *caDir)
		}
		if err := tui.CheckInteractive(sio.stdin, sio.stdout, sio.getenv("TERM")); err != nil {
			return err
		}

		root := repoDir(*repo)
		cfgPath := filepath.Join(root, "deploy.config.env")
		var existing *config.Config
		switch c, err := config.Load(cfgPath); {
		case err == nil:
			existing = &c
		case !errors.Is(err, fs.ErrNotExist):
			return fmt.Errorf("reading %s: %w", cfgPath, err)
		}
		deps, err := hostDeps(root, cfgPath, *caDir, func() (engine.Starter, error) {
			return sio.newRunner(root, cfgPath, *caDir)
		})
		if err != nil {
			return err
		}

		out, err := tui.Run(ctx, deps, existing, sio.stdin, sio.stdout)
		if err != nil {
			return err
		}
		switch out.Action {
		case tui.ActionUpgrade, tui.ActionStatus:
			name := out.Action.String()
			if code := r.Run([]string{name}, sio.stdout, sio.stderr); code != 0 {
				return fmt.Errorf("%s exited with status %d", name, code)
			}
			return nil
		case tui.ActionInstall:
			if out.Summary != "" {
				fmt.Fprintln(sio.stdout, out.Summary)
			} else {
				fmt.Fprintf(sio.stdout, "ProjectAchilles is installed: https://%s\n", out.Config.AchillesDomain)
			}
			return nil
		case tui.ActionInstallFailed:
			return fmt.Errorf("the install did not finish. Your settings are saved in %s: run achilles-installer install again "+
				"(Reconfigure), or unattended: sudo %s install --config %s --yes", cfgPath, filepath.Join(root, "achilles-installer"), cfgPath)
		default:
			return errors.New("cancelled; nothing on this server was changed")
		}
	}
}

// unattended is `install --config FILE [--yes]`: no wizard and no TTY
// needed. The config is validated first (problems: exit 1). Without --yes it
// only prints what would run (exit 2). With --yes it runs the engine,
// printing its events as plain lines, and exits with the engine's status.
func unattended(ctx context.Context, sio installIO, root, cfgFile string, yes bool, caDir string) error {
	if cfgFile == "" {
		return exitWith(2, errors.New("--yes needs --config FILE (the deploy.config.env to install from)"))
	}
	path, err := filepath.Abs(cfgFile)
	if err != nil {
		return err
	}
	c, err := config.Load(path)
	if err != nil {
		return err
	}
	if ps := c.Validate(); len(ps) > 0 {
		for _, p := range ps {
			fmt.Fprintf(sio.stderr, "%s: %s\n", p.Key, p.Message)
		}
		return exitWith(1, fmt.Errorf("%s: %d setting(s) need fixing; nothing was changed", path, len(ps)))
	}
	if !yes {
		fmt.Fprintf(sio.stdout, "Would run, in %s:\n  bash scripts/deploy-server.sh %s\n"+
			"with ACHILLES_PROGRESS=1 ACHILLES_NONINTERACTIVE=1 (no prompts). Nothing was changed.\n"+
			"To install, add --yes:\n  achilles-installer install --config %s --yes\n", root, path, path)
		return exitWith(2, nil)
	}

	starter, err := sio.newRunner(root, path, caDir)
	if err != nil {
		return err
	}
	// The engine runs in its own process group, so a terminal's ctrl+c
	// reaches only this process: cancel the run (which kills the group).
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	events, wait, err := starter.Start(ctx)
	if err != nil {
		return fmt.Errorf("could not start scripts/deploy-server.sh: %w", err)
	}
	for ev := range events {
		printEvent(sio.stdout, ev)
	}
	code := engine.ExitCode(wait())
	switch {
	case ctx.Err() != nil:
		return exitWith(130, errors.New("interrupted: the engine was stopped. Running the same command again is safe"))
	case code != 0:
		return exitWith(code, fmt.Errorf("the engine failed (exit status %d). Fix the problem above and run the same command again: it is safe to re-run", code))
	}
	if sio.getenv("ACHILLES_RENDER_ONLY") != "1" { // render-only says so itself
		fmt.Fprintf(sio.stdout, "ProjectAchilles is installed: https://%s\n", c.AchillesDomain)
	}
	return nil
}

// printEvent writes one engine event as a plain line. Text is sanitised, so
// a log or a pipe never receives escape sequences from the script.
func printEvent(w io.Writer, ev engine.Event) {
	switch ev.Kind {
	case engine.Phase:
		fmt.Fprintf(w, "==> %s\n", engine.Sanitize(ev.Text))
	case engine.OK:
		fmt.Fprintf(w, "  ✓ %s\n", ev.ID)
	case engine.Warn:
		fmt.Fprintf(w, "  ! %s\n", engine.Sanitize(ev.Text))
	case engine.Fail:
		fmt.Fprintf(w, "error: %s\n", engine.Sanitize(ev.Text))
	default:
		fmt.Fprintln(w, engine.Sanitize(ev.Text))
	}
}

// failedStart is a Starter whose Start returns err.
type failedStart struct{ err error }

func (f failedStart) Start(context.Context) (<-chan engine.Event, func() error, error) {
	return nil, nil, f.err
}

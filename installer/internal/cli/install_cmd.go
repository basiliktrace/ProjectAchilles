package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tui"
)

// defaultRepoDir is where install-onprem.sh clones ProjectAchilles.
const defaultRepoDir = "/opt/projectachilles"

// installIO is the install handler's view of the process.
type installIO struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	getenv         func(string) string
}

func init() {
	registerInstall(defaultRegistry, installIO{stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, getenv: os.Getenv})
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
			return errors.New("the unattended install (--config FILE --yes) is not implemented yet")
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
		deps, err := hostDeps(root, cfgPath, *caDir)
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
			return errors.New("the remaining wizard steps (login, analytics, organisation, review, install) are not implemented yet; nothing was written")
		default:
			return errors.New("cancelled; nothing on this server was changed")
		}
	}
}

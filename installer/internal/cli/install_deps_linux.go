//go:build linux

package cli

import (
	"net"
	"time"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tui"
)

// hostDeps wires the wizard to this host. newRunner gives a fresh engine
// run for each install attempt.
func hostDeps(root, cfgPath, caDir string, newRunner func() (engine.Starter, error)) (tui.Deps, error) {
	if _, err := newRunner(); err != nil {
		return tui.Deps{}, err
	}
	return tui.Deps{
		System:     sysprobe.RealSystem{},
		Resolver:   net.DefaultResolver,
		Interfaces: sysprobe.SystemLANInterfaces,
		RepoRoot:   root,
		ConfigPath: cfgPath,
		CADir:      caDir,
		Now:        time.Now,
		Runner: func(config.Config) engine.Starter {
			r, err := newRunner()
			if err != nil {
				return failedStart{err}
			}
			return r
		},
	}, nil
}

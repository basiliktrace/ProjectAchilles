//go:build linux

package cli

import (
	"net"
	"os"
	"time"

	"github.com/projectachilles/ProjectAchilles/installer/internal/config"
	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tui"
)

// hostDeps wires the wizard to this host.
func hostDeps(root, cfgPath, caDir string) (tui.Deps, error) {
	bin, err := os.Executable()
	if err != nil {
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
		Runner: func(config.Config) engine.Runner {
			return engine.Runner{RepoRoot: root, ConfigPath: cfgPath, InstallerBin: bin}
		},
	}, nil
}

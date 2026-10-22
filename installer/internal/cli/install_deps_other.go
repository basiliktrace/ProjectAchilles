//go:build !linux

package cli

import (
	"errors"

	"github.com/projectachilles/ProjectAchilles/installer/internal/engine"
	"github.com/projectachilles/ProjectAchilles/installer/internal/tui"
)

func hostDeps(string, string, string, func() (engine.Starter, error)) (tui.Deps, error) {
	return tui.Deps{}, errors.New("the installer runs on Linux servers only")
}

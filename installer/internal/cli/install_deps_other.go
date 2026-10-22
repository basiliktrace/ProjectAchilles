//go:build !linux

package cli

import (
	"errors"

	"github.com/projectachilles/ProjectAchilles/installer/internal/tui"
)

func hostDeps(string, string, string) (tui.Deps, error) {
	return tui.Deps{}, errors.New("the installer runs on Linux servers only")
}

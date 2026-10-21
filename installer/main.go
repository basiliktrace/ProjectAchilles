// Command achilles-installer is the on-prem installer for ProjectAchilles.
package main

import (
	"os"

	"github.com/projectachilles/ProjectAchilles/installer/internal/cli"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	cli.SetVersion(version)
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}

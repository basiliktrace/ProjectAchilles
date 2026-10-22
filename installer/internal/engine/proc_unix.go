//go:build unix

package engine

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the script in its own process group and makes context
// cancellation kill the whole group, so docker compose children do not linger.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

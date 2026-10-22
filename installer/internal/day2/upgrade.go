package day2

import (
	"bufio"
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const tlsCaddy = "deploy/caddy/tls.caddy"

var releaseTag = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)

type semver [3]int

func parseTag(s string) (semver, bool) {
	m := releaseTag.FindStringSubmatch(s)
	if m == nil {
		return semver{}, false
	}
	var v semver
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}

func (a semver) less(b semver) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// highestRelease returns the highest plain vX.Y.Z tag; agent-v* tags and
// pre-releases never match.
func highestRelease(tags string) (string, bool) {
	var best string
	var bv semver
	for _, t := range strings.Fields(tags) {
		if v, ok := parseTag(t); ok && (best == "" || bv.less(v)) {
			best, bv = t, v
		}
	}
	return best, best != ""
}

// Upgrade moves the checkout to ref (or the next release tag) and re-runs the
// engine with the existing config. A failed engine run is reported with the
// rollback steps; nothing is rolled back automatically.
func Upgrade(ctx context.Context, d Deps, ref string, yes bool) error {
	out := d.out()
	if strings.HasPrefix(ref, "-") {
		return fmt.Errorf("invalid --ref %q", ref)
	}

	// Installs from before the render-to-rendered/ change had the engine
	// overwrite this tracked file; it is no longer written, so just restore it.
	if b, err := d.git(ctx, "status", "--porcelain", "--", tlsCaddy); err == nil && strings.TrimSpace(string(b)) != "" {
		if _, err := d.git(ctx, "checkout", "--", tlsCaddy); err != nil {
			return fmt.Errorf("could not restore %s: %w", tlsCaddy, err)
		}
		fmt.Fprintf(out, "Restored %s (an older installer modified it; the engine no longer writes it).\n", tlsCaddy)
	}

	st, err := d.git(ctx, "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("checking the working tree: %w", err)
	}
	if strings.TrimSpace(string(st)) != "" {
		return fmt.Errorf("%s has uncommitted changes; refusing to upgrade over them. Commit, stash or discard them first:\n%s",
			d.RepoDir, strings.TrimRight(string(st), "\n"))
	}

	if _, err := d.git(ctx, "fetch", "--tags"); err != nil {
		return fmt.Errorf("fetching tags: %w", err)
	}
	tags, err := d.git(ctx, "tag", "--list")
	if err != nil {
		return fmt.Errorf("listing tags: %w", err)
	}
	current := ""
	if b, err := d.git(ctx, "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"); err == nil {
		if c := strings.TrimSpace(string(b)); releaseTag.MatchString(c) {
			current = c
		}
	}

	target := ref
	if target == "" {
		hi, ok := highestRelease(string(tags))
		if !ok {
			return fmt.Errorf("no release tags (vX.Y.Z) found; pass --ref")
		}
		if cv, ok := parseTag(current); ok {
			if hv, _ := parseTag(hi); !cv.less(hv) {
				fmt.Fprintf(out, "ProjectAchilles %s: already up to date.\n", current)
				return nil
			}
		}
		target = hi
	} else if target == current {
		fmt.Fprintf(out, "Already at %s.\n", current)
		return nil
	}

	from := current
	if from == "" {
		from = "(unknown)"
	}
	fmt.Fprintf(out, "Upgrade: %s -> %s\nChangelog: https://github.com/projectachilles/ProjectAchilles/releases/tag/%s\n", from, target, target)
	if !yes {
		fmt.Fprint(out, "Check out this version and re-run the installer? [y/N] ")
		if a := strings.ToLower(readLine(bufio.NewReader(d.In))); a != "y" && a != "yes" {
			return errCancelled
		}
	}

	if _, err := d.git(ctx, "checkout", target); err != nil {
		return fmt.Errorf("checking out %s: %w", target, err)
	}
	// The engine below runs from the new checkout, but this binary stays
	// the old one; updating it is a separate, explicit step.
	if d.InstallerVersion != target {
		v := d.InstallerVersion
		if v == "" {
			v = "(unknown)"
		}
		fmt.Fprintf(out, "This installer binary is %s; the checkout is now %s. To update the installer itself, run: sudo %s --dir %s --ref %s --no-run\n",
			v, target, filepath.Join(d.RepoDir, "scripts", "install-onprem.sh"), d.RepoDir, target)
	}
	if d.RunEngine == nil {
		return fmt.Errorf("no installer engine configured")
	}
	if err := d.RunEngine(ctx); err != nil {
		fmt.Fprintf(out, "\nThe upgrade to %s did not finish: %v\n", target, err)
		if current != "" {
			fmt.Fprintf(out, "To roll back: cd %s && git checkout %s, then run achilles-installer install again.\n", d.RepoDir, current)
		} else {
			fmt.Fprintf(out, "To roll back, git checkout the previous release tag in %s and run achilles-installer install again.\n", d.RepoDir)
		}
		return fmt.Errorf("upgrade to %s failed: %w", target, err)
	}
	fmt.Fprintf(out, "Upgraded to %s. Run achilles-installer status to check the stack.\n", target)
	return nil
}

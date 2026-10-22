#!/usr/bin/env bash
# ProjectAchilles on-prem bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/projectachilles/ProjectAchilles/main/scripts/install-onprem.sh | sudo bash
#   sudo bash install-onprem.sh [--ref TAG|BRANCH] [--dir /opt/projectachilles] [--no-run]
#
# Clones the repository, downloads the checksum-verified achilles-installer
# release binary (or builds it from source when no release asset exists) and
# launches the installer on the controlling terminal.
set -euo pipefail
umask 022

REPO_SLUG="projectachilles/ProjectAchilles"
REPO_URL="https://github.com/${REPO_SLUG}.git"
RELEASE_BASE="https://github.com/${REPO_SLUG}/releases/download"
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

REF=""
DIR="/opt/projectachilles"
NO_RUN=0

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: install-onprem.sh [--ref TAG|BRANCH] [--dir DIR] [--no-run]

  --ref REF   Release tag (vX.Y.Z) or branch name. Default: highest vX.Y.Z tag.
              A branch skips the release download and builds from source (needs go).
  --dir DIR   Install directory (default: /opt/projectachilles).
  --no-run    Stop after installing the achilles-installer binary.
  -h, --help  Show this help.
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref)
        [ $# -ge 2 ] && [ -n "$2" ] || die "--ref requires a value"
        REF="$2"; shift 2 ;;
      --ref=*) REF="${1#--ref=}"; [ -n "$REF" ] || die "--ref requires a value"; shift ;;
      --dir)
        [ $# -ge 2 ] && [ -n "$2" ] || die "--dir requires a value"
        DIR="$2"; shift 2 ;;
      --dir=*) DIR="${1#--dir=}"; [ -n "$DIR" ] || die "--dir requires a value"; shift ;;
      --no-run) NO_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done
  case "$DIR" in
    /*) ;;
    *) die "--dir must be an absolute path (got: $DIR)" ;;
  esac
  DIR="${DIR%/}"
  [ -n "$DIR" ] || die "--dir must not be /"
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported architecture: $(uname -m) (need x86_64 or aarch64)" ;;
  esac
}

require_env() {
  [ "$(uname -s)" = "Linux" ] || die "this installer supports Linux only"
  [ "$(id -u)" -eq 0 ] || die "must run as root (try: curl ... | sudo bash)"
  detect_arch
}

install_prereqs() {
  local missing=()
  command -v git  >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  if [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ ! -s /etc/pki/tls/certs/ca-bundle.crt ]; then
    missing+=(ca-certificates)
  fi
  [ "${#missing[@]}" -eq 0 ] && return 0
  log "Installing prerequisites: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q "${missing[@]}"
  else
    die "no supported package manager (apt-get/dnf); install manually: ${missing[*]}"
  fi
}

# Highest plain vX.Y.Z tag (no agent-v*, no pre-releases).
latest_tag() {
  git ls-remote --tags --refs "$REPO_URL" \
    | awk '{ sub("^refs/tags/", "", $2); print $2 }' \
    | grep -E "$TAG_RE" \
    | sort -V \
    | tail -n 1
}

is_tag_ref() { [[ "$1" =~ $TAG_RE ]]; }

resolve_ref() {
  if [ -z "$REF" ]; then
    log "Looking up latest release tag"
    REF="$(latest_tag || true)"
    [ -n "$REF" ] || die "could not determine the latest release tag from $REPO_URL (use --ref)"
  fi
  log "Using ref: $REF"
}

is_empty_dir() { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }

prepare_repo() {
  if [ -e "$DIR" ] && ! is_empty_dir "$DIR"; then
    [ -d "$DIR/.git" ] || die "$DIR exists and is not a ProjectAchilles git checkout; refusing to overwrite"
    local top origin
    top="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || true)"
    [ "$top" = "$(cd "$DIR" && pwd -P)" ] || die "$DIR is not the root of a git checkout; refusing to overwrite"
    origin="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
    case "$origin" in
      *"$REPO_SLUG"|*"$REPO_SLUG".git) ;;
      *) die "$DIR is a git checkout of '$origin', not $REPO_SLUG; refusing to overwrite" ;;
    esac
    if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
      die "$DIR has local changes; commit/stash them, or use '$DIR/achilles-installer upgrade' for an existing install"
    fi
    log "Updating existing checkout in $DIR"
  else
    log "Cloning $REPO_URL into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --quiet "$REPO_URL" "$DIR"
  fi

  if is_tag_ref "$REF"; then
    git -C "$DIR" fetch --quiet --tags --force origin
    git -C "$DIR" rev-parse --verify --quiet "refs/tags/$REF^{commit}" >/dev/null \
      || die "tag $REF not found in $REPO_URL"
    git -C "$DIR" checkout --quiet --detach "refs/tags/$REF"
  else
    git -C "$DIR" fetch --quiet --tags --force origin "+refs/heads/$REF:refs/remotes/origin/$REF" \
      || die "branch or tag '$REF' not found in $REPO_URL"
    git -C "$DIR" checkout --quiet --detach "refs/remotes/origin/$REF"
  fi
}

# Returns 0 on verified install, 2 when the release asset is absent (404).
download_release() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  fetch_verify_install "$tmp" || rc=$?
  rm -rf "${tmp:?}"
  return "$rc"
}

fetch_verify_install() {
  local tmp="$1" asset="achilles-installer-linux-$ARCH" code
  log "Downloading $asset ($REF)"
  code="$(curl -sSL --retry 3 -o "$tmp/$asset" -w '%{http_code}' "$RELEASE_BASE/$REF/$asset" || true)"
  case "$code" in
    200) ;;
    404) return 2 ;;
    *) die "download of $asset failed (HTTP ${code:-error})" ;;
  esac
  code="$(curl -sSL --retry 3 -o "$tmp/SHA256SUMS" -w '%{http_code}' "$RELEASE_BASE/$REF/SHA256SUMS" || true)"
  [ "$code" = "200" ] || die "download of SHA256SUMS failed (HTTP ${code:-error})"

  # --ignore-missing alone passes when the file is absent from the list.
  grep -Eq "^[0-9a-fA-F]{64} [ *]?${asset}\$" "$tmp/SHA256SUMS" \
    || die "SHA256SUMS has no entry for $asset"
  (cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS) \
    || die "checksum verification FAILED for $asset; refusing to install"
  install -m 0755 "$tmp/$asset" "$DIR/achilles-installer"
}

build_from_source() {
  command -v go >/dev/null 2>&1 \
    || die "no release binary for '$REF' and 'go' is not installed; install Go (see installer/go.mod) or use a released --ref"
  command -v make >/dev/null 2>&1 \
    || die "no release binary for '$REF' and 'make' is not installed"
  log "Building achilles-installer from source (ref $REF)"
  make -C "$DIR/installer" build VERSION="$REF"
  install -m 0755 "$DIR/installer/dist/achilles-installer-linux-$ARCH" "$DIR/achilles-installer"
}

install_binary() {
  local rc=0
  if is_tag_ref "$REF"; then
    download_release || rc=$?
    case "$rc" in
      0) return 0 ;;
      2) warn "release asset not found for $REF; falling back to a source build" ;;
      *) return "$rc" ;;
    esac
  else
    log "Ref '$REF' is not a release tag; building from source"
  fi
  build_from_source
}

tty_usable() { ( : </dev/tty ) 2>/dev/null; }

launch() {
  local bin="$DIR/achilles-installer"
  if [ "$NO_RUN" -eq 1 ]; then
    log "Installed $bin (--no-run given)"
    return 0
  fi
  if tty_usable; then
    log "Launching installer"
    exec "$bin" install </dev/tty >/dev/tty 2>&1
  fi
  log "No controlling terminal; not launching the interactive installer."
  echo "Run it interactively:      sudo $bin install"
  echo "Or non-interactively:      sudo $bin install --config $DIR/deploy.config.env --yes"
}

main() {
  parse_args "$@"
  require_env
  install_prereqs
  resolve_ref
  prepare_repo
  install_binary
  launch
}

# ACHILLES_SOURCE_ONLY=1 lets tests source the functions without running.
if [ "${ACHILLES_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi

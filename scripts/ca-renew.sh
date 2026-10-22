#!/bin/sh
# =============================================================================
# ProjectAchilles — weekly intermediate-CA renewal (TLS_MODE=achilles-ca)
# =============================================================================
# Run by achilles-ca-renew.service, which scripts/deploy-server.sh installs
# together with a weekly timer. It:
#   1. runs `achilles-installer ca renew --if-expiring 180d`, which prints
#      "renewed" or "not due";
#   2. restarts Caddy when the intermediate on disk is newer than the running
#      Caddy container. Caddy loads the CA files only at start, and its admin
#      API is off, so a reload is not possible.
#
# Step 2 compares file and container times rather than trusting step 1's
# output, so it also picks up a manual `achilles-installer ca renew`, retries
# a restart that failed last week, and still runs when step 1 errors.
#
# Before restarting, it deletes Caddy's cached leaf certificates
# (/data/caddy/certificates/local). Caddy reuses a cached leaf, chain and all,
# until the leaf nears expiry, so after a root rotation a plain restart would
# keep serving leaves that chain to the OLD root for hours. Caddy issues new
# leaves from the local CA as it starts.
#
# --restart-only skips step 1. scripts/deploy-server.sh runs it that way after
# `compose up`, so a rotation, a manual `ca init --rotate` or `ca renew`
# reaches Caddy at install time, with the same comparison as the timer.
#
# The exit status is non-zero when the renewal or the restart fails, so systemd
# records the failure; the renewal's own status wins when both fail.
# =============================================================================
set -u

CA_DIR="${ACHILLES_CA_DIR:-/etc/projectachilles/ca}"
REPO="${ACHILLES_REPO_ROOT:-/opt/projectachilles}"
INTERMEDIATE="${CA_DIR}/caddy/intermediate.crt"

renew_rc=0
if [ "${1:-}" != "--restart-only" ]; then
  : "${ACHILLES_INSTALLER_BIN:?set ACHILLES_INSTALLER_BIN to the achilles-installer binary}"
  "$ACHILLES_INSTALLER_BIN" ca renew --dir "$CA_DIR" --if-expiring 180d || renew_rc=$?
fi

compose() {
  docker compose -f "${REPO}/docker-compose.server.yml" --project-directory "$REPO" "$@"
}

# restart_if_stale: 0 = nothing to do or restarted, 1 = could not check/restart.
restart_if_stale() {
  [ -f "$INTERMEDIATE" ] || return 0
  cid="$(compose ps -q caddy)" || { echo "cannot list the caddy container" >&2; return 1; }
  cid="$(printf '%s\n' "$cid" | head -n 1)"
  # Not running: it reads the current files whenever it next starts.
  [ -n "$cid" ] || return 0
  started="$(docker inspect -f '{{.State.StartedAt}}' "$cid")" \
    || { echo "cannot inspect the caddy container" >&2; return 1; }
  started_s="$(date -d "$started" +%s)" \
    || { echo "cannot parse caddy start time '$started'" >&2; return 1; }
  issued_s="$(stat -c %Y "$INTERMEDIATE")" \
    || { echo "cannot stat $INTERMEDIATE" >&2; return 1; }
  # -ge: a same-second tie costs one extra restart, never a missed one.
  [ "$issued_s" -ge "$started_s" ] || return 0
  # A failed delete still restarts, so new leaves use the current CA, but
  # fails the run: the cached leaves stay in use until they near expiry
  # (Caddy's default lifetime is 12h).
  rc=0
  compose exec -T caddy rm -rf /data/caddy/certificates/local \
    || { echo "cannot delete Caddy's cached leaf certificates" >&2; rc=1; }
  compose restart caddy || { echo "caddy restart failed" >&2; return 1; }
  echo "caddy restarted"
  return "$rc"
}

restart_rc=0
restart_if_stale || restart_rc=$?

if [ "$renew_rc" -ne 0 ]; then
  exit "$renew_rc"
fi
exit "$restart_rc"

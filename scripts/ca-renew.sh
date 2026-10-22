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
# The exit status is non-zero when the renewal or the restart fails, so systemd
# records the failure; the renewal's own status wins when both fail.
# =============================================================================
set -u

: "${ACHILLES_INSTALLER_BIN:?set ACHILLES_INSTALLER_BIN to the achilles-installer binary}"
CA_DIR="${ACHILLES_CA_DIR:-/etc/projectachilles/ca}"
REPO="${ACHILLES_REPO_ROOT:-/opt/projectachilles}"
INTERMEDIATE="${CA_DIR}/caddy/intermediate.crt"

renew_rc=0
"$ACHILLES_INSTALLER_BIN" ca renew --dir "$CA_DIR" --if-expiring 180d || renew_rc=$?

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
  compose restart caddy || { echo "caddy restart failed" >&2; return 1; }
  echo "caddy restarted"
}

restart_rc=0
restart_if_stale || restart_rc=$?

if [ "$renew_rc" -ne 0 ]; then
  exit "$renew_rc"
fi
exit "$restart_rc"

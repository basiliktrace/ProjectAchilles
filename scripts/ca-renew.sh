#!/bin/sh
# =============================================================================
# ProjectAchilles — weekly intermediate-CA renewal (TLS_MODE=achilles-ca)
# =============================================================================
# Run by achilles-ca-renew.service, which scripts/deploy-server.sh installs
# together with a weekly timer. It:
#   1. runs `achilles-installer ca renew --if-expiring 180d`, which prints
#      "renewed" or "not due";
#   2. after a renewal, restarts Caddy. Caddy loads the CA files only at start,
#      and its admin API is off, so a reload is not possible.
#
# The exit status is non-zero when the renewal or the restart fails, so systemd
# records the failure. A restart that fails after a renewal is retried on the
# next run (marker file in ACHILLES_STATE_DIR); otherwise Caddy would keep
# signing with the old intermediate until it expired.
# =============================================================================
set -eu

: "${ACHILLES_INSTALLER_BIN:?set ACHILLES_INSTALLER_BIN to the achilles-installer binary}"
CA_DIR="${ACHILLES_CA_DIR:-/etc/projectachilles/ca}"
REPO="${ACHILLES_REPO_ROOT:-/opt/projectachilles}"
STATE="${ACHILLES_STATE_DIR:-/var/lib/projectachilles}"
PENDING="${STATE}/caddy-restart-pending"

out="$("$ACHILLES_INSTALLER_BIN" ca renew --dir "$CA_DIR" --if-expiring 180d)"
echo "$out"
if [ "$out" = "renewed" ]; then
  mkdir -p "$STATE"
  : > "$PENDING"
fi
if [ -e "$PENDING" ]; then
  docker compose -f "${REPO}/docker-compose.server.yml" --project-directory "$REPO" restart caddy
  rm -f "$PENDING"
  echo "caddy restarted"
fi

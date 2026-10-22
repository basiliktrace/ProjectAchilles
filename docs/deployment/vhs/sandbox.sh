#!/usr/bin/env bash
# Start the real achilles-installer wizard in a throwaway Ubuntu 24.04
# container that plays the server, for the VHS screenshot tapes in this
# directory. See README.md. Nothing on the machine running this changes:
# the wizard runs as root inside the container, with ACHILLES_RENDER_ONLY=1
# so the install renders files (env, Caddy, CA, bootstrap scripts) and stops
# before Docker. The container and its copy of the repo are deleted on exit.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
bin="${repo}/installer/dist/achilles-installer-linux-amd64"
[ -x "$bin" ] || { echo "build it first: make -C installer build" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$repo" archive HEAD > "${tmp}/repo.tar"
cp "$bin" "${tmp}/achilles-installer"

# SANDBOX_DNS: a resolver for the container, for hosts whose Docker DNS
# does not answer on user-defined networks (e.g. SANDBOX_DNS=1.1.1.1).
dns=()
[ -n "${SANDBOX_DNS:-}" ] && dns=(--dns "$SANDBOX_DNS")

docker run --rm -it "${dns[@]}" \
  --network pa-vhs --ip 10.0.5.20 --hostname achilles \
  --add-host achilles.corp.example.com:10.0.5.20 \
  -e ACHILLES_RENDER_ONLY=1 \
  -v "${tmp}:/src:ro" \
  pa-vhs-host:local \
  bash -c 'mkdir -p /opt/projectachilles \
    && tar -xf /src/repo.tar -C /opt/projectachilles \
    && install -m 0755 /src/achilles-installer /opt/projectachilles/achilles-installer \
    && cd /opt/projectachilles && clear && exec ./achilles-installer install'

#!/usr/bin/env bash
# Deploy the latest committed code to the VM and (re)start the prod stack.
# Run from your workstation:  ./scripts/deploy.sh user@vm-host
# Assumes the repo is already cloned at REMOTE_DIR on the VM and .env exists
# there (chmod 600). Image updates are deliberate — see --pull note below.
set -euo pipefail

HOST="${1:?usage: deploy.sh user@vm-host [remote-dir]}"
REMOTE_DIR="${2:-~/signal-engine}"
BRANCH="${BRANCH:-main}"

ssh "${HOST}" bash -se <<EOF
set -euo pipefail
cd ${REMOTE_DIR}
echo "==> Fetching ${BRANCH}"
git fetch --quiet origin ${BRANCH}
git checkout ${BRANCH}
git pull --ff-only origin ${BRANCH}

echo "==> Verifying .env is present and locked down"
test -f .env || { echo "missing .env on VM"; exit 1; }
chmod 600 .env

echo "==> Building Concierge + starting stack"
docker compose -f docker-compose.prod.yml up -d --build

echo "==> Status"
docker compose -f docker-compose.prod.yml ps
EOF

echo "Deployed. Image bumps are manual: review the freqtrade changelog, edit"
echo "the pinned tag in docker-compose.prod.yml, commit, then redeploy."

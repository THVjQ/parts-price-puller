#!/usr/bin/env bash
# Update to latest from GitHub and restart. .env is untouched.
set -e
cd "$(dirname "$0")"
git -C .. pull
docker compose pull 2>/dev/null || true
docker compose up -d --build
echo ">> Updated + restarted."

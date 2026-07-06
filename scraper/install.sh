#!/usr/bin/env bash
# One-shot install: run from inside the scraper/ folder after cloning the repo.
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> Created .env — EDIT IT NOW (nano .env), then re-run this script."
  exit 0
fi
docker compose pull 2>/dev/null || true   # grab prebuilt image if available
docker compose up -d --build
echo ">> Running. Logs: docker logs -f parts-price-puller"

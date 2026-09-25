#!/usr/bin/env bash
# Apply migrations to the production database. drizzle reads DATABASE_URL_DIRECT
# when set, so migrations go to the direct (5432) connection, never the pooler.
# Values are loaded from the root .env and never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

if [[ -z "${PROD_DATABASE_URL_DIRECT:-}" ]]; then
  echo "PROD_DATABASE_URL_DIRECT is not set in .env" >&2
  exit 1
fi

export DATABASE_URL_DIRECT="$PROD_DATABASE_URL_DIRECT"
pnpm --dir "$ROOT" db:migrate

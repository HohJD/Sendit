#!/usr/bin/env bash
# Push production env vars from the root .env to Vercel. Values are never
# printed — each one is piped straight into `vercel env add`.
# Run from anywhere; it cds itself. DATABASE_URL on Vercel is sourced from
# PROD_DATABASE_URL in .env (the pooled Supabase URL, port 6543).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/web"

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

# NAME=source-name pairs; when source == name it's a straight passthrough.
VARS=(
  DATABASE_URL:PROD_DATABASE_URL
  SESSION_SECRET:SESSION_SECRET
  CHECKOUT_SHARED_SECRET:CHECKOUT_SHARED_SECRET
  DEMO_MODE:DEMO_MODE
  PRAVA_API_BASE_URL:PRAVA_API_BASE_URL
  PRAVA_SECRET_KEY:PRAVA_SECRET_KEY
  PRAVA_CALLBACK_URL:PRAVA_CALLBACK_URL
  LLM_PROVIDER:LLM_PROVIDER
  OPENROUTER_API_KEY:OPENROUTER_API_KEY
  XAI_API_KEY:XAI_API_KEY
  NVIDIA_API_KEY:NVIDIA_API_KEY
  WASSIST_API_KEY:WASSIST_API_KEY
  TAVILY_API_KEY:TAVILY_API_KEY
  OPENAI_API_KEY:OPENAI_API_KEY
  SERPAPI_API_KEY:SERPAPI_API_KEY
  SEARCH_PROVIDER:SEARCH_PROVIDER
  IDENTIFY_MODEL:IDENTIFY_MODEL
  WHATSAPP_TOKEN:WHATSAPP_TOKEN
  WHATSAPP_PHONE_NUMBER_ID:WHATSAPP_PHONE_NUMBER_ID
  META_APP_SECRET:META_APP_SECRET
  IG_PAGE_ACCESS_TOKEN:IG_PAGE_ACCESS_TOKEN
  CHECKOUT_EXECUTOR_URL:CHECKOUT_EXECUTOR_URL
  RETURN_ORIGINS:RETURN_ORIGINS
)

for pair in "${VARS[@]}"; do
  name="${pair%%:*}"
  src="${pair##*:}"
  value="${!src:-}"
  if [[ -z "$value" ]]; then
    echo "skip $name (empty)"
    continue
  fi
  printf %s "$value" | vercel env add "$name" production --force
done

# Local setup

For an agent handoff, start with root `AGENTS.md`. It maps the source files,
provider work, verified state and remaining launch blockers. Open the whole
`sendit` folder in Cursor; the existing local `.env` must not be overwritten.

## Prerequisites

- Node 22 (the repo runs on 22.23; `engines` wants >= 22.12)
- pnpm — `corepack enable && corepack prepare pnpm@latest-10 --activate`, or `npm i -g pnpm@10` if corepack isn't installed
- Postgres — Homebrew:

```bash
brew install postgresql@17
brew services start postgresql@17
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
createdb sendit          # DATABASE_URL = postgres://<user>@localhost:5432/sendit
```

## Install

```bash
pnpm install
pnpm --filter @prava/worker exec playwright install chromium   # checkout executor browser
```

## Environment

One file serves both processes: a root `.env` (the worker loads it via
`--env-file-if-exists=../../.env`), plus a symlink `apps/web/.env -> ../../.env`
(Astro loads env relative to `apps/web`; `astro.config.mjs` also calls
`process.loadEnvFile('.env')` so plain `process.env` code in the shared
packages sees it too). Both are gitignored. `.env.example` lists every key.

```bash
test -e .env || cp .env.example .env
if [ ! -e apps/web/.env ] && [ ! -L apps/web/.env ]; then ln -s ../../.env apps/web/.env; fi
openssl rand -hex 32   # use for SESSION_SECRET and CHECKOUT_SHARED_SECRET
```

| Var | Meaning |
|-----|---------|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | Signs the session cookie and the `/chat-login` links |
| `CHECKOUT_SHARED_SECRET` | Guards `/execute` — required, the executor spends minted cards |
| `DEMO_MODE` | `true` forces canned matches without vision/search keys |
| `PRAVA_API_BASE_URL` | `https://sandbox.api.prava.space` for test purchases |
| `PRAVA_SECRET_KEY` | Prava sandbox key |
| `PRAVA_CALLBACK_URL` | https URL Prava returns the cardholder to (the worker's `/prava/return`) |
| `RETURN_ORIGINS` | Comma-separated front ends the return route may bounce back to |
| `WEB_ORIGIN` | Public base URL of the dashboard — used to build the checkout link sent over WhatsApp. Defaults to `http://localhost:4321` |
| `OPENAI_API_KEY` | Vision and extraction with an OpenAI model; optional when another model provider is used |
| `IDENTIFY_MODEL` | `grok*` → xAI; `vendor/model` → NVIDIA NIM; bare id → OpenAI. When blank, defaults follow the available key: xAI, then OpenAI, then NIM. Verify model access before live use. |
| `XAI_API_KEY` | Vision identify via xAI (`grok-*` models — recommended) |
| `NVIDIA_API_KEY` | Vision identify via NVIDIA NIM (namespaced `IDENTIFY_MODEL`) |
| `SERPAPI_API_KEY` | Google Shopping discovery; optional when using Tavily |
| `TAVILY_API_KEY` | Web-search discovery — an alternative to SerpAPI |
| `SEARCH_PROVIDER` | `tavily` or `serpapi`; unset → whichever key is present, `serpapi` when both are |
| `META_APP_SECRET` | Signs `x-hub-signature-256` on every webhook (same app covers IG + WA) |
| `META_VERIFY_TOKEN` | Handshake token for the Instagram webhook |
| `WHATSAPP_TOKEN` | WhatsApp Cloud API bearer token |
| `WHATSAPP_PHONE_NUMBER_ID` | The business phone number's *ID* (not the number itself) |
| `WHATSAPP_VERIFY_TOKEN` | Handshake token for the WhatsApp webhook — any string you choose |
| `IG_PAGE_ACCESS_TOKEN` | Instagram messaging + handle→IGSID lookup at sign-in. Optional in a WhatsApp-first setup |
| `WASSIST_API_KEY` | Replies via Wassist's REST API — alternative to the Meta setup |
| `WASSIST_WEBHOOK_SECRET` | Signs `X-Wassist-Signature` on `/webhooks/wassist` |

## Providers

Example configuration (check the model is available to your account first):

```env
IDENTIFY_MODEL=grok-4.7
XAI_API_KEY=...
TAVILY_API_KEY=...
```

SerpAPI + OpenAI (or NVIDIA NIM) remain fully supported — the provider follows
the model id and the `SEARCH_PROVIDER` env. Caveat: Tavily is a general web
index, so prices are extracted from page text by the LLM rather than coming
from structured shopping data — products whose pages don't state a price in
the snippet show as view-only (no Buy button).

## Database

`packages/db/drizzle.config.ts` reads `DATABASE_URL` from the shell
environment — it does **not** load `.env` itself, so export it first:

```bash
export DATABASE_URL=postgres://<user>@localhost:5432/sendit
pnpm db:migrate        # applies packages/db/migrations
# regenerate after schema edits: pnpm db:generate
```

Set `DATABASE_URL_DIRECT` to point migrations at a direct (non-pooled)
connection — it takes precedence over `DATABASE_URL`, so runtime can use a
Supabase/Neon transaction pooler while drizzle still gets a real session.

## Run

```bash
pnpm worker            # intake webhooks + resolver + /execute on :8787
pnpm dev               # dashboard on :4321
# or: pnpm --filter @prava/web exec astro dev --background
```

## Tunnels

Meta webhooks must be public https, and the phone needs to reach the checkout
link the bot sends. Two tunnels:

```bash
ngrok http 8787        # worker — webhook callback URL
ngrok http 4321        # dashboard — set WEB_ORIGIN=https://<this-tunnel>
```

(Or skip the second tunnel and use the Vercel deploy as `WEB_ORIGIN` —
the chat-login link works against any reachable dashboard.)

## WhatsApp Cloud API

1. **developers.facebook.com** → *Create app* → type **Business**.
2. In the app's product list, add **WhatsApp** → *API Setup*.
3. Copy the **temporary access token** (valid ~24h) → `WHATSAPP_TOKEN`.
   For a permanent token later: Business Settings → *System Users* → create
   one, grant `whatsapp_business_messaging`, generate a token — it never
   expires.
4. Copy the **Phone number ID** shown under the test number → `WHATSAPP_PHONE_NUMBER_ID`.
5. Under *API Setup → "To"*, add your own phone — the Meta test number can
   message up to 5 recipients, and each must confirm a code once.
6. *App settings → Basic → App Secret* → `META_APP_SECRET`.
7. Pick any string for `WHATSAPP_VERIFY_TOKEN` — you re-type it into Meta.
8. *WhatsApp → Configuration → Webhook*: callback
   `https://<ngrok-8787>/webhooks/whatsapp`, verify token = step 7, then
   subscribe the **`messages`** field.
9. The **24-hour customer-service window**: the bot can only send messages
   into a window the user opened by messaging first — fine here, every send
   is a reply. No approved message templates needed.

Test it end to end: text `hi`, paste an Instagram/TikTok link, or send a
screenshot of a product. You'll get a
match card with Approve/Not-this-one buttons; Approve replies with a signed
link (valid 15 min) that logs you into the checkout page.

## Wassist (alternative to Meta setup)

Instead of wiring a Meta app yourself, Wassist hosts the WhatsApp side and
forwards inbound messages to `/webhooks/wassist`. Both adapters reuse the Sendit
pipeline, but identities are keyed by platform and sender: switching from Wassist
to direct Meta WhatsApp does not automatically merge the accounts.

1. Sign in at [wassist.app](https://wassist.app) with your own phone, and stay
   in your **personal organization** (Settings → Organization) — sandbox chats
   live there.
2. **Settings → Developers → API keys** → Create → `WASSIST_API_KEY`.
3. **Settings → Developers → Webhooks** → Create with URL
   `https://<ngrok-8787>/webhooks/wassist`, keep **Subscription message
   received** ticked, copy the signing secret → `WASSIST_WEBHOOK_SECRET`.
4. **Numbers → Sandbox → Routing** → *Webhook: forward to your endpoint* →
   pick the webhook → Save routing.

Sandbox routing only affects your own chat with the sandbox number — nobody
else's messages reach the endpoint. Going live means connecting a real number
(WABA or a Wassist-provided one) under **Numbers**, then routing it the same
way.

## Demo mode

`DEMO_MODE=true` replaces identification/search with canned product results;
it does not mock Prava or guarantee a successful merchant checkout. Media is
still acquired first, so an unreadable link requests a screenshot rather than
returning a canned result.

Demo mode also activates if all vision keys are missing
(`OPENAI_API_KEY`/`XAI_API_KEY`/`NVIDIA_API_KEY`) or both search keys are missing
(`TAVILY_API_KEY`/`SERPAPI_API_KEY`), even with `DEMO_MODE=false`.
For real matching, configure one model provider and one search provider, select
them with `IDENTIFY_MODEL` and `SEARCH_PROVIDER`, then set `DEMO_MODE=false`.
Restart the worker after changing `.env`. API outages with configured keys do
not currently trigger automatic canned fallback.

## Prava sandbox

`PRAVA_API_BASE_URL=https://sandbox.api.prava.space` plus `PRAVA_SECRET_KEY`
(see README's env list) gives test purchases: passkey approval is real, but
the minted card is a sandbox credential — declines at real merchants are
expected and prove the card reached a real processor. `PRAVA_CALLBACK_URL`
must be https and point at the worker (`https://<ngrok-8787>/prava/return`).

## Smoke test without Meta

With `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_TOKEN`, and
`WHATSAPP_PHONE_NUMBER_ID` set to any values in `.env` (they only need to
exist — a fake token fails on Meta's side, not ours, and send failures are
logged without marking the share failed):

```bash
BODY='{"entry":[{"changes":[{"field":"messages","value":{"messages":[{"id":"wamid.t1","from":"15551234567","type":"text","text":{"body":"want this https://www.instagram.com/reel/XYZ/"}}]}}]}]}'
SIG="sha256=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | cut -d' ' -f2)"
curl -s -X POST http://localhost:8787/webhooks/whatsapp -H "x-hub-signature-256: $SIG" -H 'content-type: application/json' -d "$BODY"
```

This queues a link share, but the example URL is a placeholder: expect media
acquisition to fail, not three product results. Use the mocked worker tests for
repeatable offline verification. Do not replay real users' webhooks or run this
against a worker with live messaging credentials without their permission.
Plain text does not queue a search. Repeated guidance is suppressed until a new
share arrives; duplicate-message protection is currently process-local.

## Deploy (Vercel)

Dashboard deploys to Vercel; the worker stays self-hosted (ngrok or a real
host) — Vercel needs `CHECKOUT_EXECUTOR_URL` to reach it. The Supabase
pooled URL goes in `PROD_DATABASE_URL` and the direct URL in
`PROD_DATABASE_URL_DIRECT` (both in the local `.env`; never committed).

```bash
(cd apps/web && vercel link --yes --project sendit)   # once; keep this shell at the repo root
./scripts/vercel-migrate.sh                          # migrate the prod DB
./scripts/vercel-env.sh                              # push env vars to Vercel
(cd apps/web && vercel --prod)                       # deploy; verify workspace upload includes packages/db and apps/worker
```

After the first deploy, set `WEB_ORIGIN` in `.env` to the Vercel URL so
WhatsApp checkout links point at the deployed dashboard, and update
`PRAVA_CALLBACK_URL` / `RETURN_ORIGINS` to the https endpoints.
Both worker and web must use the same hosted database and shared session/executor
secrets; do not leave the worker pointing at the local database while Vercel uses
Supabase. Resolve the authentication and credential-exposure blockers in
`AGENTS.md` before opening the application to public users.

## Continuing on this Mac or another machine

Cursor on this Mac can open this folder and use the existing toolchain and local
Postgres database. `apps/web/.env` points to the root `.env`. Current worker output
is in `sendit-worker.log` (gitignored). Check port 8787 before launching another
worker; a second instance must not compete for the same queue.

A GitHub clone contains source, migrations, static assets and deployment helpers,
but not the local secrets, database records or logged-in service accounts. On a
new machine, follow the prerequisites above, recreate `.env` securely, install
Playwright Chromium and apply migrations to a fresh database. Existing database
records require a separate private backup/restore if you need to keep them. Never
commit that backup to this public repository. ngrok credentials and browser
binaries live outside the project directory by design.

Keep other assistants' WhatsApp auto-replies disabled in the sandbox test chat.
The user should send one screenshot manually for a controlled integration test;
all regression tests should mock outbound sends.

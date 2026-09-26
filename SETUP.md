# Local setup

Start with root `AGENTS.md` for the source map, provider work, verified state
and remaining launch blockers. Open the whole `sendit` workspace in your editor;
the existing local `.env` must not be overwritten.

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
| `LLM_PROVIDER` | `openrouter`, `openai`, `xai`, or `nim`; explicit selection overrides model-name inference |
| `OPENROUTER_API_KEY` | OpenRouter key for image identification and Tavily result extraction; no direct OpenAI/xAI key required |
| `OPENAI_API_KEY` | Vision and extraction through the direct OpenAI API; optional with OpenRouter |
| `IDENTIFY_MODEL` | Model ID for the selected provider. OpenRouter defaults to `openrouter/free`; other defaults and legacy inference are listed below. |
| `XAI_API_KEY` | Vision identify via the direct xAI API (`grok-*` models) |
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

### OpenRouter + Tavily

Add these settings to the existing root `.env`, using your own key locally:

```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
IDENTIFY_MODEL=openrouter/free
SEARCH_PROVIDER=tavily
DEMO_MODE=true
```

Paste your OpenRouter key after `OPENROUTER_API_KEY=` and keep the existing
`TAVILY_API_KEY` unchanged. This block intentionally keeps demo mode on until a
controlled live test is approved. Real matching requires `DEMO_MODE=false`.
Restart the worker after changing `.env`; editing the file does not update the
existing process. Never overwrite the entire local `.env` with the template.

OpenRouter routes through `https://openrouter.ai/api/v1` using the existing
OpenAI SDK. The SDK package does not require a direct OpenAI API key: requests
use `OPENROUTER_API_KEY` exclusively when this provider is selected. The model
reads the image, Tavily discovers store pages, and the model extracts products
from those pages. Wassist and Prava do not change.

The default `openrouter/free` router uses only free models, selecting an available
model that supports the request's image/JSON requirements. Its catalog lists zero
prompt/completion prices (checked 2026-09-26). There is no automatic paid-model
fallback. Models may differ between identification and extraction, free capacity
is rate-limited, and availability/quality still need a live test with your key.
Tavily has its own credits and pricing; free model inference does not make every
service free. Any explicitly chosen replacement model must support images and
JSON output. Both calls include
`provider.require_parameters=true` so unsupported parameters are not silently
ignored; an incompatible provider/model returns an error instead. OpenRouter
requests have a 30-second per-attempt timeout and at most one retry.

### Provider selection

| `LLM_PROVIDER` | Key | Default model when `IDENTIFY_MODEL` is blank |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/free` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| `xai` | `XAI_API_KEY` | `grok-4.7` |
| `nim` | `NVIDIA_API_KEY` | `moonshotai/kimi-k2.6` |

Without `LLM_PROVIDER`, existing behavior is retained: an explicit `grok*` model
selects xAI, a model containing `/` selects NIM, and a bare model selects OpenAI.
**Set `LLM_PROVIDER=openrouter` for OpenRouter's namespaced model IDs.** When
both provider and model are blank, available keys are checked in order: xAI,
OpenAI, NIM, OpenRouter. This preserves existing setups. Invalid provider names
fail explicitly; a failed API call does not silently switch providers.

`SEARCH_PROVIDER` selects Tavily or SerpAPI independently. Tavily uses the selected
model for extraction; its prices come from page snippets rather than structured
shopping data. Products without a price are view-only. Model extraction does not
guarantee that prices are current or correct.

### Offline checks and first live test

```bash
pnpm --filter @prava/worker test
pnpm --filter @prava/worker exec tsc --noEmit
pnpm resolve -- /absolute/path/to/product.png
```

The first two commands mock provider responses and do not contact WhatsApp. The
last command uses your configured providers and may incur charges when demo mode
is off; it does not send a chat reply or start a checkout. Verify the result there
before asking the user to send one real screenshot in the connected WhatsApp chat.

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

Demo mode also activates when the selected model provider's key or the selected
search provider's key is missing, even with `DEMO_MODE=false`. For example,
`LLM_PROVIDER=openrouter` requires `OPENROUTER_API_KEY`; having an OpenAI key
instead does not satisfy it. A selected Tavily backend requires `TAVILY_API_KEY`,
not a SerpAPI key. The reason identifies the missing variable without logging
its value.

For real matching, configure `LLM_PROVIDER`, `IDENTIFY_MODEL`, `SEARCH_PROVIDER`
and the two corresponding keys, then set `DEMO_MODE=false`. Restart the worker
after changing `.env`. API outages with configured keys do not currently trigger
automatic canned fallback.

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
Postgres database. `apps/web/.env` points to the root `.env`. Worker output goes
to its launching terminal; `sendit-worker.log` holds earlier runs (gitignored).
Check port 8787 before launching another worker; a second instance must not
compete for the same queue.

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

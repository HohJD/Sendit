# Sendit development guide

## Start here

Open this entire workspace, not just `apps/web`. Read `SETUP.md` for setup and
`apps/web/AGENTS.md` before frontend work. This is a working sandbox demo, not a
production-ready payment application.

## Architecture

- `apps/web`: Astro + React dashboard, sign-in, signed chat links and Prava checkout UI.
- `apps/worker/src/channels`: Wassist (currently connected), Meta WhatsApp and Instagram adapters.
- `apps/worker/src/conversation`: chat input policy, approval links, duplicate and repeated-hint protection.
- `apps/worker/src/resolver`: media acquisition, identification, product discovery and demo catalog.
- `apps/worker/src/payments/prava.ts`: sandbox payment API client.
- `apps/worker/src/checkout`: Playwright merchant checkout executor.
- `packages/db`: shared Postgres/Drizzle schema and committed migrations.
- `scripts/vercel-env.sh`, `scripts/vercel-migrate.sh`: production setup helpers; they modify remote services, so run only with approval.
- `apps/web/public`: mascot, icons and social preview assets. No external temporary image paths are required.

## Current state (verified 2026-09-26)

- Local Postgres `sendit`, Astro on port 4321 and worker on port 8787 are configured on this Mac.
- Wassist forwards signed events to the worker through ngrok. A GET health check does not prove screenshot/button round trips work; verify these with the user.
- The user chose to continue building here using OpenRouter rather than handing off Grok Bot work. No Grok Bot bridge is required.
- `DEMO_MODE=true` was retained. Tavily, Wassist and Prava credentials have been tested previously. OpenRouter is implemented and mocked tests pass, but an authenticated live model call remains outstanding; do not claim real identification has been verified.
- Vercel project `hohjds-projects/sendit` has been configured with root `apps/web`; no live deployment has been verified. Hosted Postgres connection strings are missing.
- After a Hermes/Sendit bot-to-bot loop, the user confirmed Hermes auto-replies were stopped and explicitly approved restarting Sendit. The worker was restarted and local/public health checks returned 200. Do not re-enable Hermes auto-replies in this test chat.

## Next task: OpenRouter live verification

The provider is implemented; do not build another messaging bot or MCP bridge.

1. Inspect `resolver/llm.ts`, `identify.ts`, `search.ts`, `tavily.ts`, `resolve.ts`, and `demo.ts`, plus their tests.
2. Obtain `OPENROUTER_API_KEY` through the local `.env`, not chat. Use `LLM_PROVIDER=openrouter`, `IDENTIFY_MODEL=openai/gpt-4.1-mini`, and `SEARCH_PROVIDER=tavily`. No direct OpenAI or xAI key is needed for that setup.
3. The public catalog lists the default model with image and JSON-format support. Confirm account access/credits with a controlled live call; do not infer that from mocked tests. Both identification and Tavily extraction use the same selected model.
4. With user approval, set `DEMO_MODE=false`, restart the worker, and run `pnpm resolve -- /absolute/path/to/product.png` from the root. This CLI resolves an image without sending a WhatsApp reply or starting a checkout; provider requests can incur charges.
5. Confirm identification, JSON extraction, merchant URL/price accuracy, timeouts and failure behavior. OpenRouter requests require parameter support and use a 30-second per-attempt timeout with one retry. OpenAI/xAI/NIM remain available through explicit provider selection or legacy inference.
6. Test one screenshot and one unreadable link through Wassist with the user. Only URLs/images may trigger a chat search. Do not send automated test traffic to their phone.

`LLM_PROVIDER` overrides model-name inference. Without it, model IDs containing
`/` retain legacy NIM routing. Set it explicitly for OpenRouter. When neither
provider nor model is set, keys are considered in order xAI, OpenAI, NIM,
OpenRouter. Demo mode checks the selected provider keys rather than any available
key; invalid provider names fail instead of silently routing elsewhere.

## Commands

Run from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @prava/worker test
pnpm --filter @prava/worker exec tsc --noEmit
pnpm --filter @prava/web build
```

An Astro build is not a full frontend typecheck.

```sh
pnpm worker
pnpm --filter @prava/web exec astro dev --background
curl http://localhost:8787/health
```

Check for existing listeners before starting another process. Stop the existing worker
before restarting to load changed environment values. Worker output goes to the
terminal used to launch it; `sendit-worker.log` contains earlier runs (gitignored).
Older logs/screenshots in `/tmp` are diagnostics only, not application dependencies.

## Secrets and portability

- Root `.env` is local and gitignored; `apps/web/.env` is a relative symlink to it. Never overwrite the existing `.env` with the example.
- `.env.example` contains names/defaults only. Never print, commit or paste keys, database passwords, signed login links, session cookies or card credentials.
- On this Mac, Cursor can use the existing database and toolchain. A GitHub clone does not contain secrets, local database contents, running servers, ngrok credentials or Playwright browser downloads. Recreate these using `SETUP.md` on another machine; do not copy the database or user messages into the public repository.
- Node, pnpm, PostgreSQL, ngrok and Playwright browser binaries are installed outside the source folder. The database schema/migrations and dependency lockfile are inside it.

## Guardrails and remaining blockers

- Sandbox only. Never place a real order, switch to production payment credentials or replay approvals without specific permission. Do not equate a sandbox decline with a successful purchase.
- Existing `/dev-login` identifies by email, not verified authentication. Replace it before public use; it does not automatically link WhatsApp finds to an email account.
- `/api/payment-result/[sessionId]` currently returns credentials to its React consumer. Remove that exposure and adapt the client together before public use. Audit logging of signed links and provider errors as well.
- Validate externally fetched media/redirects against SSRF, add bounded download sizes/timeouts, and validate LLM-extracted prices before production use.
- `/explore` still calls a separate Shopify catalog provider, not Tavily. The chat resolver's provider key detection is now provider-aware; Explore integration is still outstanding.
- Media acquisition happens before demo resolution: an unreadable URL can still fail in demo mode and should request a screenshot, not invent a result. Missing-key fallback exists; automatic provider-outage fallback has not been implemented.
- Message deduplication and hint suppression are bounded process-local caches (10,000 entries), reset on restart; add durable idempotency and outbound rate limiting before scaling. Run only one resolver worker until queue claiming is made atomic.
- The current `identities` key includes platform. Matching phone digits do not automatically merge Wassist and direct WhatsApp accounts.
- For Vercel, provision hosted Postgres, migrate it, and point both the Mac worker and web app at that same database. Keep `SESSION_SECRET` and `CHECKOUT_SHARED_SECRET` aligned across both. Configure reachable `WEB_ORIGIN`, `CHECKOUT_EXECUTOR_URL` and `PRAVA_CALLBACK_URL`; localhost links do not work on another phone.

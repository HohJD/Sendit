## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Verification and deployment handoff

- From the workspace root, run `pnpm --filter @prava/web build` and `pnpm --filter @prava/worker test`.
- A successful Astro build is not a full TypeScript check. Worker typecheck: `pnpm --filter @prava/worker exec tsc --noEmit`.
- Vercel project: `hohjds-projects/sendit`, root directory `apps/web`. As verified on 2026-09-26, it has no deployments; hosted database configuration is still outstanding.
- Before public deployment, replace the identity-only `/dev-login` flow with verified authentication and prevent `/api/payment-result/[sessionId]` from returning card credentials. Update its React consumer together with that API change.
- `/explore` currently uses the separate catalog search provider, not the Tavily provider used by the chat resolver. Do not assume Tavily credentials enable Explore.
- Email-only sign-in does not link a WhatsApp identity. Open the signed link received in chat to access that chat account.
- Never log environment values, signed login links, session cookies, or payment credentials during verification.
- Incident on 2026-09-26: Hermes and Sendit replied to each other. The user subsequently confirmed Hermes replies were stopped and approved a restart; the worker is running again with successful health checks. Keep Hermes auto-replies disabled for this chat. See root `AGENTS.md` for the current handoff.
- The conversation handler suppresses repeated guidance until a new share is queued and deduplicates messages in a bounded, process-local cache (10,000 entries). These protections reset on restart and do not replace durable idempotency or disabling the other bot. Validate fixes with mocked outbound sends, never live replay to the user's phone.

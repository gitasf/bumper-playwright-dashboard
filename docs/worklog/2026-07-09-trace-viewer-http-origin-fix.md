# 2026-07-09 — Fix trace viewer "Could not load trace": force https origin for the embed URL

## What changed

The self-hosted Playwright Trace Viewer (`/trace-viewer/index.html?trace=…`, added
in the embedded-Test-Replay work — see `2026-07-08-embedded-trace-replay.md`)
refused to open traces from the production dashboard. The viewer's service worker
failed to fetch the trace, with browser console errors like:

> Connecting to 'http://dash.wrightful.dev/api/artifacts/…/download?t=…' violates
> the following Content Security Policy directive: "connect-src 'self' data: blob:".
>
> Fetch API cannot load http://dash.wrightful.dev/api/artifacts/…/download?t=… .
> Refused to connect because it violates the document's Content Security Policy.

(The public `trace.playwright.dev` link-out shows the same failure as
"Could not load trace … grant permission for Local Network Access" — the generic
mixed-content symptom.)

Root cause: the trace-viewer URL builder embedded the artifact download URL with
an **`http://`** scheme. The viewer page is served over https, so fetching an
`http://` same-host URL is (a) mixed content and (b) not `'self'` under the
`connect-src 'self'` CSP in `void.json` (scheme mismatch) — so the browser blocks it.

The scheme came from `new URL(c.req.url).origin`. Behind Cloudflare, TLS is
terminated upstream and `c.req.url` can surface `http://` even on an https
deployment, so `url.origin` was `http://dash.wrightful.dev`. That origin is
embedded verbatim into the absolute `?trace=` download URL by
`signedTraceViewerUrl(origin, …)`.

The fix prefers the deploy's declared, canonical `WRIGHTFUL_PUBLIC_URL`
(a required `url()` in `env.ts`, always https in prod) over the per-request origin
when building the trace-viewer embed URL, so the embedded trace URL is https and
same-origin as the viewer page.

Both entry points that mint a trace-viewer URL were fixed: the test-detail page
loader (right-rail Replay) and the on-demand `replay.ts` route (the run test-list
per-row Replay button + `?replay=` deep-link).

## Details

| File                                                                                                  | Change                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/config.ts`                                                                    | New `resolvePublicOrigin(source, requestOrigin)` helper — returns `WRIGHTFUL_PUBLIC_URL`'s origin when set, else falls back to the request origin (keeps local dev / e2e, where both are the same `http://localhost` origin, unchanged). |
| `apps/dashboard/pages/t/[teamSlug]/p/[projectSlug]/runs/[runId]/tests/[testResultId]/index.server.ts` | Test-detail loader derives `origin` via `resolvePublicOrigin(env, url.origin)` instead of raw `url.origin`.                                                                                                                              |
| `apps/dashboard/routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/tests/[testResultId]/replay.ts`  | On-demand Replay route (per-row button / deep-link) does the same.                                                                                                                                                                       |
| `apps/dashboard/src/__tests__/config.workers.test.ts`                                                 | Added `resolvePublicOrigin` coverage: prefers env origin over request origin; reduces a full URL to just the origin; falls back on unset/empty env.                                                                                      |

Scope note: the fix is orthogonal to the direct-R2 byte path (ADR 0003) — under
direct-R2 the same-origin worker download URL still 302s to R2, and the origin
fix keeps that download URL https/same-origin for the viewer. The in-page download
`href` is relative (no origin), so it was never affected — only the absolute
trace-viewer embed needed the canonical origin.

## Verification

- `pnpm --filter @wrightful/dashboard test:workers` — all suites pass (includes the new `resolvePublicOrigin` cases).
- `pnpm check` — exit 0 (format + lint + type-check). The remaining warnings are pre-existing `no-unsafe-type-assertion` in `packages/reporter/src/client.ts`, unrelated to this change.

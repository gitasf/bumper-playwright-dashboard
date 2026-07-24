# 2026-07-08 — Fix GitHub OAuth `state_mismatch` by pinning the auth origin + secure cookies

## Symptom

After the own-account deploy finally shipped (see
`2026-07-07-better-auth-mcp-oauth-tables.md` — the migrate fix that unblocked
`wrangler deploy`), signing in via GitHub redirected to:

```
http://dash.wrightful.dev/api/auth/error?error=state_mismatch
```

## Root cause

Better Auth's social-login flow stores an OAuth `state` in both the
`verification` table **and** a signed `state` cookie, then re-checks the cookie
on the `/api/auth/callback/github` leg. `?error=state_mismatch` fires when that
cookie can't be matched.

Void derives Better Auth's `baseURL` per request from
`new URL(request.url).origin`. Better Auth then keys the state cookie's
`__Secure-` prefix off that origin's scheme
(`better-auth/dist/cookies/index.mjs`: `baseURLString.startsWith("https://")`,
because Void passes `baseURL` as the `URL.origin` **string**, so the
`dynamicProtocol` branch never applies). Behind our Cloudflare custom domain the
worker resolves the **callback** leg's `request.url` as `http://` (proven by the
`http://` error URL — `errorURL` is `${baseURL}/error`), even though the browser
is on https. Result: the https sign-in leg sets `__Secure-better-auth.state`,
the http callback leg looks for a bare `better-auth.state`, the cookie "isn't
found", and Better Auth 302s to `error=state_mismatch`.

This is an infra/protocol-perception issue, **not** a regression from the `mcp`
OAuth plugin — that plugin touches none of the cookie/secure config (verified by
grepping `better-auth/dist/plugins/oidc-provider` + `.../mcp`). The session
cookie is unaffected because Void's generic `getCookie` falls back to the
`__Secure-` prefix; the OAuth state check uses the exact prefixed name and has no
such fallback, so only OAuth broke.

## Fix (`apps/dashboard/auth.ts`)

When `WRIGHTFUL_PUBLIC_URL` is https (prod), the request-time `defineAuth`
callback now:

- Sets `advanced.useSecureCookies: true`. In Better Auth's prefix logic this is
  evaluated **before** the per-request `baseURL` protocol, so both the sign-in
  and callback legs name the state cookie identically (`__Secure-…`) regardless
  of the scheme the worker perceives. This is the lever that actually resolves
  `state_mismatch`.
- Pins `baseURL` to the https public URL and adds it to `trustedOrigins`, so the
  OAuth `redirect_uri` (and the error redirect) are deterministic https and
  can't drift http between the authorize and token-exchange legs.

Guarded on an https public URL, so `http://localhost` dev is a no-op. Read via
the request-time `env` binding (`Record<string, unknown>`, so `typeof`-guarded)
— not `process.env`, which is empty on the Cloudflare runtime.

## Environment prerequisites (verify on the deployment)

- `WRIGHTFUL_PUBLIC_URL` must be `https://dash.wrightful.dev` (its documented
  purpose — it already drives OAuth callback links).
- The GitHub OAuth app's Authorization callback URL must be
  `https://dash.wrightful.dev/api/auth/callback/github` (https). With `baseURL`
  now pinned to https, the `redirect_uri` is always https.
- Ideally also enable an edge http→https redirect (Cloudflare "Always Use
  HTTPS") so the worker stops seeing http legs at all — the app-level fix makes
  auth resilient to it either way.

## Verification

- `pnpm check` → exit 0 (format + lint + type-check).
- `pnpm test:workers` auth/config suites (`mcp-auth.workers`, `config.workers`)
  → 30/30 passing.
- Traced the exact `state_mismatch` path through `better-auth@1.6.11`
  (`oauth2/state.mjs` → `state.mjs#parseGenericState` → `cookies/index.mjs`
  prefix logic) to confirm `useSecureCookies` is the overriding lever.

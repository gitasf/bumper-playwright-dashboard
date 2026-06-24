# 2026-06-24 — Fix production hang: Void caches the prod Postgres pool across requests

## What changed

Patched `void@0.9.2` (via pnpm `patchedDependencies`) so the generated `void/db`
instance creates a **fresh `pg.Pool` per query chain in production**, instead of
caching a single `pg.Pool` at module scope and reusing it across requests.

This fixes a total outage of all **authenticated** dashboard pages on the first
production deploy: every authed request returned a Cloudflare `1101`
_"The Workers runtime canceled this request because it detected that your
Worker's code had hung and would never generate a response."_ Logged-out pages
worked.

| File                             | Change                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patches/void@0.9.2.patch` (new) | Rewrites the `dialect === "postgresql"` virtual-`void/db` template in `dist/index.mjs`: drop the module-scope `_prodInstance` cache; `getInstance()` now returns `drizzle(new pg.Pool({ connectionString: getConnectionString(), max: 1 }), { schema })` for both local (`DATABASE_URL`) and prod (`HYPERDRIVE`). |
| `package.json`                   | `patchedDependencies` gains `"void@0.9.2": "patches/void@0.9.2.patch"`.                                                                                                                                                                                                                                           |
| `pnpm-lock.yaml`                 | Records the patch hash; dashboard now resolves the patched void variant.                                                                                                                                                                                                                                          |

## Root cause

Void 0.9.2's generated production `void/db` module cached its Drizzle/`pg.Pool`
instance at module scope and reused it across requests:

```js
// node_modules/void/dist/index.mjs — postgresql virtual-module template (BEFORE)
let _prodInstance;
function getInstance() {
  if (getRuntimeBinding("DATABASE_URL")) {
    return drizzle(
      new pg.Pool({
        connectionString: getRuntimeBinding("DATABASE_URL"),
        max: 1,
      }),
      { schema },
    );
  }
  // Production (Hyperdrive): cache the instance — Hyperdrive handles pooling.
  _prodInstance ??= drizzle(getConnectionString(), { schema }); // BUG
  return _prodInstance;
}
```

On workerd a TCP socket is bound to the request (I/O context) in which it was
opened and is severed at request end. A `pg.Pool` cached in module scope holds a
socket from a prior request; the next request that reuses it awaits I/O that can
never be scheduled, so the response promise never settles and Cloudflare's
dead-event-loop detector cancels the request with the `1101` "never generate a
response" error. Void's own comment in the _local_ branch already documented this
hazard ("workerd kills TCP sockets between requests… cached connections go stale
and hang") but the production branch did the opposite, on the assumption that
"Hyperdrive handles pooling." Hyperdrive pools **server-side** (Worker→origin);
it does not make the Worker-side socket reusable across requests.

Why it was authed-only and why it escaped testing:

- **Anonymous requests** return in `middleware/01.context.ts` before any
  `void/db` read, so they never touch the cached instance.
- **Login/session** uses `void/auth` (`runtime/better-auth-pg.mjs`), which opens
  **and disposes a fresh `pg.Pool` per request** — so auth works, which also
  proves the Hyperdrive credentials are valid (ruling out the separate stale-creds
  failure mode). The first authed _page_ read (`resolveTenantBundleForUser`) is
  the first call through the cached `db`, so it hangs.
- **Local dev / e2e** run the `DATABASE_URL` branch (fresh pool) or pglite, never
  the cached Hyperdrive branch. This was effectively the maiden run of the
  production pg path.

## Verification

- Primary Cloudflare docs confirm the mechanism (verified via research agents):
  - Hyperdrive _connection-lifecycle_: "always create database clients inside
    your request handlers, not in the global scope… a client created in the
    global scope persists across requests. Workers do not allow I/O across
    request contexts, so this client becomes stale."
  - _tcp-sockets_: "TCP sockets cannot be created in global scope and shared
    across requests."
  - Workers _errors_: the `1101`/"never generate a response" is a hung-promise /
    dead-event-loop detector, **not** a CPU (`1102`) or wall-clock timeout.
- Adversarial review (two independent skeptics) confirmed the diagnosis survives
  scrutiny; the strongest alternative (stale Hyperdrive branch creds → FATAL
  28000, the 2026-06-23 incident) is eliminated by the observed fact that login
  works.
- `pnpm install` applied the patch to the dashboard's resolved void variant
  (`void@0.9.2_patch_hash=43ff08…`); `_prodInstance` is gone from `dist/index.mjs`.
- `pnpm --filter @wrightful/dashboard build` succeeds; the emitted worker bundle
  `dist/ssr/assets/_virtual_void-db-*.js` contains:
  ```js
  function getInstance() {
    return drizzle(
      new esm_default.Pool({ connectionString: getConnectionString(), max: 1 }),
      { schema: schema_exports },
    );
  }
  ```
  — no module-scope cache.

## Notes / follow-ups

- **Performance:** a fresh `pg.Pool({max:1})` per query chain re-runs a full TCP
  connect and Postgres auth handshake per chain. Behind Hyperdrive this is
  documented as fast (Hyperdrive maintains the origin pool); it's the same
  tradeoff Void already ships for local dev. Not a correctness risk.
- **Fragility:** this is a `pnpm` patch pinned to `void@0.9.2`. A Void bump will
  drop the patch and must be re-generated (or the fix upstreamed). File upstream
  against Void; a clean-room repro exists at `/Users/joefairburn/void-pg-d1-repro`.
- This is distinct from the `scripts/void-patches/*` postbuild patches (which
  rewrite `dist/ssr/wrangler.json`); this one patches the plugin source so the
  emitted worker JS is corrected, covering both `void deploy` and `deploy:cf`.
- **Not yet deployed** — fix is built and verified locally only.

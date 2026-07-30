# 2026-07-30 — `void/ws` rooms must read `WRIGHTFUL_PUBLIC_URL` lazily

## What broke

Cloudflare's `Workers Builds: bumper-e2e-dashboard` check failed at the deploy
step with a validation error, not a build error:

```
✘ [ERROR] A request to the Cloudflare API (/accounts/…/workers/scripts/bumper-e2e-dashboard/versions) failed.
  Uncaught Error: env: Cloudflare env is unavailable. Use void runtime bindings inside … Worker handlers.
    at getRawRuntimeEnv … in readKey … in get
    at virtual_void-routes-*.js:27341
  [code: 10021]
Failed: error occurred while running deploy command
```

## Cause

Both `void/ws` room routes wired their gate at **module scope** with an eager
env read:

```ts
// routes/ws/project/[projectId].ws.ts, routes/ws/run/[runId].ws.ts
export default defineRoom(
  defineGuardedRoom({
    publicUrl: env.WRIGHTFUL_PUBLIC_URL,          // eager — runs on import
    internalSecret: () => resolveInternalSecret(env), // already lazy
    …
  }),
);
```

`void/env` only has Cloudflare bindings inside a request. Cloudflare executes a
worker's top-level scope to validate a `wrangler versions upload`, so the eager
read threw there and failed the **deploy**. `internalSecret` was already a thunk
for a closely related reason (a misconfig throw must not break room connects);
`publicUrl` simply never got the same treatment.

Nothing caught it: `pnpm check`, both dashboard test lanes, the reporter tests,
the Playwright suite, and `pnpm --filter @wrightful/dashboard build` all pass
with the bug present, because no lane imports the route files for real — only a
deploy does.

## Fix

`GuardedRoomConfig.publicUrl` is now `() => string`, resolved per connect inside
the `onBeforeConnect` gate (its only consumer), exactly like `internalSecret`.
Both route files pass `() => env.WRIGHTFUL_PUBLIC_URL`.

## Not introduced by the merge it surfaced on

The eager read is byte-identical on `main`: its built routes chunk carries the
same two reads at lines 27333/27358 (this branch's 27341/27366 differ only by an
unrelated 8-line offset). `main`'s last green Workers Build predates the failure;
a rebuild of `main` would fail the same way. The merge only changed which line
number appeared in the stack.

## Verification

- An AST walk over the built SSR chunks for env-proxy reads outside any function
  found exactly the two reported reads on `main` and **none** after the fix. The
  one remaining hit is `@better-auth/core`'s own `env` shim, which falls back to
  `globalThis` and cannot throw.
- `src/realtime/__tests__/ws-rooms.test.ts` gains "reads the public URL PER
  connect (lazily), not at wiring time", mirroring the existing
  `internalSecret` laziness test. Confirmed non-vacuous: adding a wiring-time
  `config.publicUrl()` makes it fail.
- `pnpm check` (0 errors), `pnpm test` (dashboard node + workers lanes, reporter)
  all pass; dashboard production build succeeds.

The deploy itself is only observable from CI — the Cloudflare build logs are not
reachable locally, so the Workers Build check on the PR is the real confirmation.

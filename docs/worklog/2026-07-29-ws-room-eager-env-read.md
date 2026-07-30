# Lazy `publicUrl` in the `void/ws` rooms (deploy-blocking eager env read)

## Why

Cloudflare's Workers Build for PR #72 failed at upload validation while every
GitHub Actions job — including `Dashboard Build` and the real-Postgres leg —
passed:

```
✘ [ERROR] A request to the Cloudflare API (/accounts/…/workers/scripts/wrightful/versions) failed.
  Uncaught Error: env: Cloudflare env is unavailable. Use void runtime bindings
  inside … Worker handlers.
    at getRawRuntimeEnv (assets/env-DeTyoufN.js:54:9)
    at readKey  (assets/env-public--6AQ9EiU.js:349:17)
    at get      (assets/env-public--6AQ9EiU.js:393:10)
    at          (assets/virtual_void-routes-BpI3_Lmw.js:27342:19)   [code: 10021]
```

Cloudflare evaluates the worker's top level to validate an upload, with no
request in flight. Both `.ws.ts` rooms passed `publicUrl: env.WRIGHTFUL_PUBLIC_URL`
into `defineGuardedRoom` — and `defineRoom(defineGuardedRoom({…}))` is a
module-scope call, so that read happened during exactly that evaluation.

### Why it only failed sometimes

This line shipped in `dda1c4e` and deployed fine for weeks, then flapped
fail → pass → fail across three consecutive commits. That is not noise to wave
away; it is the shape of the bug. void's raw env resolver (`void@0.10.10`,
`env-raw`) is:

```js
var cloudflareEnv;
if (
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers"
)
  import("cloudflare:workers")
    .then((mod) => {
      cloudflareEnv = asEnv(mod.env) ?? void 0;
    })
    .catch(() => {});

function getRawRuntimeEnv() {
  return (
    envContext.getStore() ?? // AsyncLocalStorage — populated per request
    getNuxtEnv() ?? // globalThis.__env__ — n/a here
    cloudflareEnv ?? // ← assigned ASYNCHRONOUSLY, in a .then()
    (() => {
      throw new Error("env: Cloudflare env is unavailable…");
    })()
  );
}
```

At module scope the first two are empty by definition, so an eager read falls
through to `cloudflareEnv` — a variable assigned on a **microtask** from a
dynamic `import("cloudflare:workers")`. The read therefore races that
assignment: lose the race and the deploy dies with 10021, win it and the deploy
passes. Same source, same bundle, different day.

Confirmed by building `c2be11f` (Workers Build: success) and `5afc742`
(failure). Both emit `publicUrl: env$1.WRIGHTFUL_PUBLIC_URL` at the _same_ lines
(27342 / 27367) of the same eagerly-imported `virtual_void-routes` chunk — which
the entry imports statically, because it re-exports the `WsRunRunIdWs` /
`WsProjectProjectIdWs` Durable Object classes. Nothing in the repo distinguishes
the passing build from the failing one.

The precise lever that flips the race is NOT pinned down. The obvious candidate
— a top-level `await` in the eager graph draining microtasks mid-evaluation — is
absent from both the entry and the routes chunk. Left open: whether
`navigator.userAgent === "Cloudflare-Workers"` holds in the validation isolate
under a given compat date, and workerd-side module-init scheduling. None of it
matters for the fix: this code has no business racing that assignment at all.

The sibling field `internalSecret` was already a thunk, and its doc comment
already spelled out the rule ("called per publish request … NOT at wiring
time"). `publicUrl` simply never followed it.

## What changed

- `GuardedRoomConfig.publicUrl` is now `() => string`, resolved per CONNECT
  inside `onBeforeConnect` rather than at wiring time. `isAllowedWsOrigin` keeps
  its plain-string parameter.
- Both `routes/ws/{run/[runId],project/[projectId]}.ws.ts` pass
  `() => env.WRIGHTFUL_PUBLIC_URL`.
- `src/realtime/__tests__/ws-rooms.test.ts` now mocks `void/env` the way the
  platform behaves instead of the way that is convenient: a proxy that THROWS
  until a flag is flipped, flipped only after the route modules are imported.
  The previous plain-object mock resolved eagerly, which is the whole reason a
  deploy-breaking read passed every test and every local build.

## Why not something else

Keeping `publicUrl: string` and resolving it at the route boundary inside a
function would work too, but the thunk puts the laziness in the type — a future
room cannot reintroduce the bug without changing the signature.

## Verification

- Mutation-checked: restoring the eager read makes `ws-rooms.test.ts` fail at
  import with the production error text verbatim ("env: Cloudflare env is
  unavailable"). Restoring it in `room-server.ts` alone fails typecheck.
- Built before and after. The pre-fix bundle reproduces the failing frame
  byte-for-byte — `virtual_void-routes-*.js:27342` is
  `publicUrl: env$1.WRIGHTFUL_PUBLIC_URL` — and the post-fix bundle has
  `publicUrl: () => env$1.WRIGHTFUL_PUBLIC_URL` at the same line.
- Audited the rest of the eagerly-evaluated routes chunk. Everything before the
  throwing line is proven safe by production itself (it evaluated without
  throwing, and ESM hoisting means every chunk it imports ran first); at/after
  it there are exactly three env reads — the two fixed here and
  `runPgMigrations(env, …)`, where `env` is a function parameter, not the proxy.
- `pnpm check`: 0 errors, 154 warnings (unchanged). Dashboard node 767 passed /
  8 skipped, workers 1,413 passed. `pnpm build` exit 0.
- Workers Build went green on `51b088f`. Treat that as CORROBORATION, NOT proof:
  the failure is a race, and the immediately preceding green (`c2be11f`) carried
  the bug untouched. The load-bearing evidence is structural — `getRawRuntimeEnv`
  is no longer reached during module evaluation at all, so there is no longer a
  race to lose. A single green deploy could never have shown that.

**Not run:** the deploy from here — this sandbox has no Cloudflare credentials,
and the wrangler session on the developer's machine is expired.

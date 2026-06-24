# 2026-06-21 — Polar billing: thermo-nuclear code-quality review fixes

Follow-up to `2026-06-20-polar-billing.md`. Two passes over the uncommitted billing
feature — a strict maintainability review (`/thermo-nuclear-code-quality-review`) and an
architecture-deepening review (`/improve-codebase-architecture`) — surfaced one
correctness defect and a cluster of structural cleanups. This entry records the four
fixes applied; the remaining findings were deliberately **not** taken (see "Deferred").

## What changed

### 1. `applyMirror` ordering guard is now atomic (correctness fix)

`src/lib/billing/polar-webhook.ts` — the apply-if-newer billing-mirror guard was a
non-atomic **SELECT → compare-in-JS → unconditional UPDATE**. Two webhooks delivered
concurrently (each on its own pooled connection) could both read the same stale
`billingUpdatedAt`, both pass the guard, and let the later-committing write win by
wall-clock order — silently resurrecting cancelled paid access (`tier=pro` after a
`subscription.revoked`), the exact failure the guard exists to prevent. It also
violated the repo's `runBatch`/`db.transaction` atomicity convention.

Collapsed to a **single DB-serialized conditional UPDATE**:

```ts
db.update(teams)
  .set({ ...set, billingUpdatedAt: incomingAt })
  .where(
    and(
      eq(teams.id, teamId),
      or(
        isNull(teams.billingUpdatedAt),
        lte(teams.billingUpdatedAt, incomingAt),
      ),
    ),
  );
```

A 0-row result (`changedRows(res) === 0`) means "missing team" _or_ "stale event"; a
cheap existence probe runs **only on that path** to preserve the two distinct log
lines. Boundary semantics are unchanged: apply on `incomingAt >= stored` (equal
applies), skip on `<`, and `IS NULL` matches the prior `?? 0` fallback.

### 2. De-duplicated the Polar Date→epoch-seconds coercer (DRY)

`toSeconds` (polar-webhook.ts) and `toEpochSeconds` (reconcile.ts) were byte-for-byte
identical and both fed the same `currentPeriodEnd` bigint mirror — and the webhook
copy also feeds the ordering key, so silent drift between the two would desync the
writer from its own reconcile backstop. Extracted one **`polarDateToSeconds`** into a
new import-free `src/lib/billing/polar-time.ts`; both modules import it.

### 3. Moved billing-period semantics out of the quota module (cohesion)

`effectiveTier` + `BILLING_PERIOD_GRACE_SECONDS` were defined in `src/lib/usage.ts`
(the quota module), forcing the dedicated `billing/*` package to import _backwards_
into it. Moved both into a new pure, import-free `src/lib/billing/tier.ts`. All
dependency arrows now point **into** `billing/*`; `usage.ts` imports `effectiveTier`
from there.

### 4. Consolidated the four webhook handlers into one writer (cohesion)

A follow-on architecture review (`/improve-codebase-architecture`) flagged that
`onSubscriptionActive` / `onOrderPaid` / `onSubscriptionCanceled` /
`onSubscriptionRevoked` each repeated the same shape — `resolveTeamId →
unresolved-guard+log → incomingAt derivation → applyMirror` — so the resolve / guard /
ordering-key rules lived in four places. Extracted one internal
`writeMirrorEvent(type, data, set)` that owns all of it; each exported handler is now a
one-line `set` declaration. The four exports stay (auth.ts registers them as named
`webhooks({ … })` callbacks); `data` is the structural shape both `Subscription` and
`Order` satisfy. Net: the guard / ordering-key path is tested once, then each event's
`set` mapping is asserted, instead of four near-identical guard tests. (The same review's
other finding — the duplicated Date→epoch coercer — was already addressed by fix #2.)

## Details

| File                                                                          | Change                                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/billing/tier.ts`                                                     | **new** — `effectiveTier` + `BILLING_PERIOD_GRACE_SECONDS` (pure, zero imports)                                                                  |
| `src/lib/billing/polar-time.ts`                                               | **new** — `polarDateToSeconds` (pure, zero imports)                                                                                              |
| `src/lib/billing/polar-webhook.ts`                                            | atomic `applyMirror`; four handlers collapsed onto one `writeMirrorEvent`; uses `polarDateToSeconds`; imports `and/or/isNull/lte`, `changedRows` |
| `src/lib/billing/reconcile.ts`                                                | uses `polarDateToSeconds`; imports grace const from `billing/tier`                                                                               |
| `src/lib/billing/subscription.ts`                                             | imports `effectiveTier` from `billing/tier`                                                                                                      |
| `src/lib/usage.ts`                                                            | removed the two definitions; imports `effectiveTier` from `billing/tier`                                                                         |
| `src/__tests__/usage.workers.test.ts`, `src/__tests__/pg-integration.test.ts` | re-pointed the two symbols' imports to `billing/tier`                                                                                            |

No schema, env, or wire-contract changes. No behavior change for sequential webhook
delivery; the only observable difference is that concurrent out-of-order delivery can
no longer lose the ordering guard.

### Void best-practices follow-up (two small alignment fixes)

A `/void` review of the branch confirmed the feature is idiomatic Void (env via
`defineEnv`/`void/env`, `defineScheduled` cron with a collision-free expression,
`defineAuth` extending `defaults` + spreading `defaults.plugins`, `createAuthClient`
from `void/client`, RSC page root + `"use client"` only at the interactive leaves,
Drizzle reads, `void/log`). Two low-priority tightenings were taken:

- **`POLAR_MODE` is now `oneOf(["sandbox", "production"])`** (`env.ts`) instead of a
  bare `string().default("sandbox")`. A typo'd value is now rejected at validation
  time (`void env check` / first access / `void deploy`) and `void env example`
  emits an `# enum:` hint, rather than silently degrading to sandbox. Both readers
  (`auth.ts`, `reconcile.ts`) compare `=== "production"`, unaffected; the
  pg-integration fixture sets the valid `"sandbox"`.
- **Checkout fallback `successUrl` → `/settings`** (`auth.ts`) instead of the
  `/settings/teams/__/billing?checkout=success` placeholder, whose literal `__` slug
  would 404 if the default ever fired. The browser always passes a team-scoped
  `successUrl` (`billing-actions.tsx`), so the default is effectively unreachable —
  this just makes the unreachable path land somewhere valid.

Deliberately **left as-is**: `auth.ts` reading `process.env.POLAR_*` (rather than
`void/env`). That's load-bearing, not an oversight — `void prepare` evaluates `auth.ts`
in a bare Node context that can't resolve the `@/lib` alias for static value imports,
so the config-time gate is inlined exactly like the established `githubOAuthEnabled` /
`openSignupAllowed` / `emailConfigured` siblings. The keys are still declared in
`env.ts`, so the deploy-time validation gate is unaffected.

## Deferred (intentionally not changed)

- **The `BillingProvider` seam** (one-method interface + registry + two adapters +
  result-union over a single function with one caller). A real over-abstraction today,
  and the architecture review sharpened the symptom: "billing off → skip reconcile" is
  encoded three times (the cron's `billingEnabled`, the `NoopBillingProvider`, and
  `reconcile.ts`'s `!POLAR_ACCESS_TOKEN` belt — though the last is intentional
  defense-in-depth for a direct call). But the seam is an explicit **ADR-0002** decision
  (future closed-overlay split), so it's an ADR-revisit conversation, not a silent
  refactor. Open.
- **Closed-union typing** for `tier`/`subscriptionStatus` and **splitting the 1k-line
  `pg-integration.test.ts`** — both judgment calls; the test split is not net-simpler
  (it duplicates the fragile dual-driver harness).

## Verification

- `pnpm check:fix` — format + lint: **0 errors** (114 pre-existing warnings, all in
  e2e fixtures, unrelated).
- `pnpm --filter @wrightful/dashboard typecheck` (`void prepare && tsgo --noEmit`) — **clean**.
- Node lane `src/__tests__/pg-integration.test.ts` — **31/31 passed** (incl. the
  webhook ordering-guard, idempotency, reconcile, and `effectiveTier` billing cases —
  confirms the atomic `applyMirror` preserves apply-if-newer semantics).
- Workers lane (`vitest.workers.config.ts`) — **1098/1098 passed** (97 files; incl.
  `usage.workers.test.ts` `effectiveTier` units + `config.workers.test.ts`).
- Void best-practices follow-up re-verified: `void prepare && tsgo --noEmit` **clean**,
  `vp lint env.ts auth.ts` **0 errors**, `billing-ui.test.tsx` **9/9 passed**. `oneOf`
  confirmed exported from `void/env` (`EnvSchema<Values[number]>`), so the typed
  `env.POLAR_MODE` narrows to `"sandbox" | "production"`.

Note: a _deterministic_ concurrency regression test isn't feasible against the
single-connection pglite lane (it serializes writes, so old and new code behave
identically there); the apply-if-newer boundary is covered by the existing sequential
ordering-guard test, which passes against the new atomic implementation.

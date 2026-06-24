# 2026-06-20 — Polar.sh billing ($10/team/mo Pro) — capability-flagged, off ⇒ unlimited

Implements the spec in `.context/polar-billing-plan.md` and the decision in
`docs/adr/0002-capability-flagged-billing-provider.md`. Adds a flat
**$10/team/month** Pro subscription via the `@polar-sh/better-auth` Better Auth
plugin, mirroring just enough subscription state onto the `teams` row for
synchronous gating.

**Central invariant (OSS safety):** billing is an optional, capability-flagged
provider. When billing is **OFF** (no `POLAR_*` env — the open-source /
self-host default) **every team is UNLIMITED** — no caps, no billing UI, no
webhook. Free-tier caps + the finite Pro caps + the trial + the billing UI exist
**only** when billing is configured (the hosted/cloud deployment). The single
runtime signal is `billingEnabled()` — there is no `WRIGHTFUL_EDITION` enum.

All work landed on the `feature/pg` branch (not split into separate PRs, per the
maintainer's request); the sections below mirror the plan's PR sequence.

---

## PR 1 — Schema mirror + env declarations + `billingEnabled()` + dependencies

**What changed**

- **Dependencies** (`apps/dashboard/package.json`): added
  `@polar-sh/better-auth@^1.8.4` + `@polar-sh/sdk@^0.47.1`. `pnpm why better-auth`
  confirms a **single** `better-auth@1.6.11` tree shared by both the Polar plugin
  and `void@0.9.2` — no `pnpm.overrides` needed.
- **Schema** (`apps/dashboard/db/schema.ts`): five additive, nullable billing-mirror
  columns on `teams`, right after `tier` — `polarCustomerId` (text, the
  trial-vs-paid discriminator), `polarSubscriptionId` (text), `subscriptionStatus`
  (text), `currentPeriodEnd` (bigint epoch-seconds), `billingUpdatedAt` (bigint
  epoch-seconds, the apply-if-newer ordering guard). The `tier` JSDoc was
  refreshed (the old comment named Stripe and said non-free = unlimited, both now
  wrong). No `subscriptions`/`customers` table — the Polar plugin owns nothing
  locally. Better Auth's `user`/`session`/`account`/`verification` stay undeclared.
- **Migration** (`db/migrations/20260620214503_motionless_reaper.sql`): generated
  via `pnpm db:generate`; five `ALTER TABLE "teams" ADD COLUMN` statements, all
  additive/non-destructive.
- **Env** (`apps/dashboard/env.ts`): `POLAR_ACCESS_TOKEN` + `POLAR_WEBHOOK_SECRET`
  (`string().secret().optional()` — the two halves of `billingEnabled()`),
  `POLAR_MODE` (`string().default("sandbox")`), `POLAR_PRO_PRODUCT_ID`
  (`string().optional()`), and the three finite Pro caps
  `WRIGHTFUL_PRO_MONTHLY_RUNS` (25000), `WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS`
  (5000000), `WRIGHTFUL_PRO_ARTIFACT_BYTES` (100 GiB) — mirroring the existing
  `WRIGHTFUL_FREE_*` declarations. Pro-cap defaults are **PLACEHOLDER / TBA**.
- **Capability flag** (`apps/dashboard/src/lib/config.ts`): `billingEnabled(source)`
  appended after `resolveArtifactTokenSecret`, mirroring `githubAppEnabled` —
  pure, takes a `source` env object, `Boolean(POLAR_ACCESS_TOKEN && POLAR_WEBHOOK_SECRET)`.
- **Test** (`apps/dashboard/src/__tests__/config.workers.test.ts`): a
  `billingEnabled` describe block mirroring `githubOAuthEnabled` (both present →
  true; either missing/empty-string → false).

**Verification**

- `pnpm check` — green (0 errors; the 114 warnings are pre-existing reporter/e2e
  type-assertion lints, none in changed files).
- `pnpm --filter @wrightful/dashboard exec void prepare` — codegen clean.
- `config.workers.test.ts` — 14 passed (incl. the 4 new `billingEnabled` cases).
- Migration diff — one additive migration, exactly the 5 columns.

---

## PR 2 — Pure tier/expiry logic + the billing-off UNLIMITED short-circuit

**What changed** (`apps/dashboard/src/lib/usage.ts`)

- **`tierLimits(tier)`** now leads with `if (!billingEnabled(env)) return { runs:
Infinity, testResults: Infinity, artifactBytes: Infinity }` — the OSS-safety
  short-circuit and the ONLY uncapped path. This fixes the verified failure mode
  (a self-hoster on defaults silently hitting the free caps). When billing is ON,
  `'free'` → `WRIGHTFUL_FREE_*`, every other tier (`'pro'` / trial-pro) → the
  finite `WRIGHTFUL_PRO_*` ceilings (was `Infinity`). No new enforcement code: the
  existing `evaluateQuota` soft-warn-then-429 machinery now enforces Pro because
  the limit is finite. (Mechanism A — `tierLimits` keeps its ambient-`env`
  signature.)
- **`BILLING_PERIOD_GRACE_SECONDS`** (2 days) + **`effectiveTier(tier,
currentPeriodEnd, nowSeconds)`** added: a `pro` past `currentPeriodEnd + grace`
  is treated as `free` (D9 self-healing); `currentPeriodEnd == null` → tier stands.
- **`checkQuota`** + **`loadTeamUsage`** now select `teams.currentPeriodEnd` and
  feed `effectiveTier(...)` into `tierLimits(...)`, so the displayed limits match
  enforcement. No signature changes (both already took `nowSeconds`).

**Test** (`apps/dashboard/src/__tests__/usage.workers.test.ts`): converted to mock
`void/env` (Mechanism A — `vi.hoisted` mutable config + `vi.mock("void/env")`,
the `email.workers.test.ts` idiom) so billing-off and billing-on are both
exercisable. Added: billing-OFF → all-Infinity for every tier; billing-ON →
free reads `WRIGHTFUL_FREE_*`, pro reads finite `WRIGHTFUL_PRO_*` (explicitly NOT
Infinity); `effectiveTier` grace-boundary / expiry / null / free cases. Existing
pure describes preserved (the mock is inert for them).

**Verification**

- `usage.workers.test.ts` — 19 passed (7 new).
- Full workers lane — 1098 passed; node lane — 180 passed.
- `pnpm check` — green standalone (the type-aware-lint error count flickers under
  chained/concurrent invocations — a known `vp check` cache artifact; the
  authoritative standalone run is 0 errors).

---

## PR 3 — Auth wiring + `BillingProvider` seam + webhook handlers + reconcile

**Pre-work (verified the live SDK surface, not just the plan's facts).** Inspected
the installed `@polar-sh/better-auth@1.8.4` + `@polar-sh/sdk@0.47.1` dist:
`polar`/`checkout`/`portal`/`webhooks`/`polarClient` all exported; the webhook
callbacks are `(payload: Webhook<Event>Payload) => Promise<void>` with
`WebhookSubscriptionActivePayload.data: Subscription`,
`WebhookOrderPaidPayload.data: Order` (so the `{ data: Subscription|Order }`
handler typing is a structural supertype and typechecks); `CheckoutOptions` has
`products: { productId, slug }[]` / `successUrl` / `authenticatedUsersOnly` /
`theme`; `void/db` exports `isNotNull`. All matches resolved fact 10.

**What changed**

- **`BillingProvider` seam** (`apps/dashboard/src/lib/billing/`): `types.ts` (the
  interface + `BillingOpResult` + `ReconcileSummary`, zero runtime imports),
  `polar-provider.ts` (real adapter delegating to `reconcileBilling`),
  `noop-provider.ts` (OSS default — graceful no-op), `billing-registry.ts`
  (`resolveBillingProvider(enabled)` — the only module importing both concretes).
  Mirrors the `MonitorExecutor` two-adapter pattern + the email graceful-no-op.
- **`reconcile.ts`** (lands here, not PR6, because `polar-provider.ts` statically
  imports it): `reconcileBilling(nowSeconds)` keys on the held `polarCustomerId`
  via `sdk.subscriptions.list({ customerId })` (a `PageIterator`, consumed with
  `for await`), corrects `tier` + `currentPeriodEnd` only, respects the grace
  window, and does **NOT** bump `billingUpdatedAt` (ordering-guard correctness).
- **`polar-webhook.ts`**: the apply-if-newer mirror writers
  (`onSubscriptionActive`/`onOrderPaid`/`onSubscriptionCanceled`/`onSubscriptionRevoked`).
  Team resolved from `metadata.referenceId` (narrowed with `typeof`); unresolved →
  `logger.error` + ack. `subscription.canceled` is status-only (D4); `revoked` is
  the only tier downgrade. Typed against the real component types — no `any`.
- **`auth.ts`**: `process.env` Polar config + `polarConfigured` (inline twin of
  `billingEnabled`); static `@polar-sh` imports; `buildPolarPlugin()` (checkout +
  portal + webhooks with deferred dynamic-import handlers, the github-mirror
  pattern); `plugins: [...(defaults.plugins ?? []), ...(polarConfigured ?
[buildPolarPlugin()] : [])]` — **spreads `defaults.plugins`** (a hardening over
  the plan, which clobbered it) so no void-default plugin is dropped.
- **`auth-client.ts`**: replaced the `void/client` `auth` re-export with
  `createAuthClient({ basePath: "/api/auth", plugins: [polarClient()] })`. The two
  consumers import only the `authClient` symbol, so they're mechanically unaffected.
- **`POLAR_MODE` narrowing**: used `=== "production" ? "production" : "sandbox"`
  (a clean union-typed ternary) instead of an `as` cast, to avoid a new
  `no-unsafe-type-assertion` warning.

**Off-state:** with `POLAR_*` unset, `polarConfigured` is false → no plugin
registers → `POST /api/auth/polar/webhooks` 404s, and `resolveBillingProvider(false)`
returns `NoopBillingProvider`. PR 3 is self-contained (the
`billing-registry → polar-provider → reconcile` chain resolves).

**Verification**

- `tsgo --noEmit` — exit 0 (the deterministic authority; the whole seam +
  reconcile + handlers + auth wiring typecheck, no `any`).
- `void prepare` — config-time eval of the new `auth.ts` clean (static Polar
  imports resolve; DB handlers deferred).
- `vp check` — 0 errors across 3 consecutive standalone runs (86 warnings, all
  pre-existing; my 2 transient cast-warnings removed by the ternary).
- Both test lanes — workers 1098 passed, node 180 passed (the auth-client swap
  didn't regress the two consumers). Handler/reconcile DB tests land in PR 6.

---

## PR 4 — 14-day trial seed at team creation

**What changed** (`apps/dashboard/src/lib/provisioning.ts`)

- Added `TRIAL_DAYS = 14` / `TRIAL_SECONDS` module constants.
- `createTeamForUser` (the single real team-birth site — verified callers are
  `pages/settings/teams/new.server.ts` + `routes/api/teams/index.ts`;
  github-setup + invite-accept only insert memberships into existing teams) now
  seeds the trial in its `teams` insert: `tier="pro"`, `currentPeriodEnd = now +
TRIAL_SECONDS`, `polarCustomerId = null` (the trial-vs-paid discriminator). The
  insert stays inside the existing `runBatch`.

**⚠️ No-backfill gap (Risk #10) — recorded for a future operator.** The trial
seeds only at team birth, so it applies only to teams created **after** this
change. This is moot pre-launch (zero users — the dashboard has never deployed).
But if billing is ever switched ON for a cloud instance that already has teams on
the default `tier="free"`, those pre-existing teams are immediately free-capped
with no trial. Granting them a trial would need a one-off backfill (`tier="pro"`

- `currentPeriodEnd = now + 14d` + `polarCustomerId = null` for existing free
  teams). No such backfill exists; it's intentionally deferred.

**Verification:** `tsgo --noEmit` exit 0. The trial round-trip (read-back +
re-cap-to-free-after-grace) is asserted in PR 6 (pg-integration lane).

---

## PR 5 — Billing page + nav + checkout/portal triggers (three-state UI)

**What changed**

- **`src/lib/billing/subscription.ts`** — `loadTeamBilling(teamId, nowSeconds)`
  reads the `teams` mirror on the Drizzle query builder, applies `effectiveTier`,
  and classifies the three states: `free`, `trial` (`tier=pro` + `polarCustomerId
== null`), `paid` (`tier=pro` + customer set), with `trialDaysLeft`. No SDK import.
- **`billing.server.ts`** (`pages/settings/teams/[teamSlug]/`) — owner-only loader
  gated on `requireRoleScope(c, "manageMembers")` (NOT tenant-context, which 404s
  off a `/p/:project`); reads the canonical `billingEnabled(env)`; formats
  `priceLabel`/`periodEndLabel`; surfaces `checkoutSuccess` from `?checkout=success`.
- **`billing.tsx`** — RSC page: the off-state (`!billingEnabled`) renders first and
  returns early (not-configured Alert, no actions — the OSS view), then free /
  trial / paid with the correct CTA (trial → Upgrade, not Manage). The
  webhook-race success notice + `BillingSuccessPoller` show only when
  `?checkout=success` and not-yet-paid.
- **`billing-actions.tsx`** — `"use client"` leaves: `UpgradeButton` →
  `authClient.checkout({ slug: "pro", referenceId: teamId, successUrl: <team-scoped> })`,
  `ManageButton` → `authClient.customer.portal()`, `BillingSuccessPoller` (bounded
  ~30s `router.refresh()` loop; never writes state — the webhook is authoritative).
- **Nav threading (Risk #8 — done the right way):** `billingEnabled` is a global
  deployment flag, so it's added as a top-level `SharedBundle` field, computed
  server-side in `middleware/01.context.ts` via `billingEnabled(env)` (both the
  STUB and the real bundle), and read on the client through `useShared()`. The
  Billing nav link (`app-layout.tsx`, icon `CreditCard`) is gated
  `isExpandedTeamOwner && billingEnabled` — no `void/env` in the client tree.

**Risk #2 (client method namespacing) — resolved at the type level.**
`authClient.checkout(...)` and `authClient.customer.portal()` typecheck against
the inferred `polarClient()` `$InferServerPlugin` types (`tsgo` exit 0). The
runtime sandbox confirmation is step **5f** below (user-run).

**Risk #1 (THE top integration risk — `referenceId` → `metadata.referenceId`):
UNVERIFIED, must be confirmed by a real sandbox checkout before trusting team
resolution.** `UpgradeButton` passes `referenceId: teamId`; the webhook handlers
(PR 3) read `metadata.referenceId`. Whether `@polar-sh/better-auth` actually
threads the checkout `referenceId` onto the resulting `subscription`/`order`
webhook `metadata.referenceId` was **not** runtime-verified. **5f (user-run, dev,
billing ON):** complete a Polar sandbox checkout for a known `teamId`, inspect the
`subscription.active`/`order.paid` webhook payload (Polar dashboard event log or a
temporary `logger.info`), and confirm `data.metadata.referenceId === teamId`. If
it does NOT propagate, switch the team-carrier strategy (explicit
`metadata: { referenceId }` on the checkout call, or a `polarCustomerId → teamId`
map at first checkout) before relying on any team-resolution code.

**Verification**

- `void prepare` clean (new route registered); `tsgo --noEmit` exit 0; `vp check`
  0 errors / 86 warnings (no new warnings).
- Both test lanes still green (workers 1098, node 180) — the SharedBundle field
  addition didn't regress the type-contract test (it asserts individual fields,
  not the full shape).

---

## PR 6 — Reconcile cron + DB-backed pg-integration tests

**What changed**

- **`crons/reconcile-billing.ts`** — daily reconcile cron at `30 4 * * *` (a fresh
  slot — verified against the crons/ inventory: rollup-usage `0 3`, sweep-retention
  `0 *​/6`, the reaper family, etc.). Reads `billingEnabled(env)`, resolves the
  provider, calls `provider.reconcile(now)` — a clean no-op when billing is off
  (NoopBillingProvider). Logs via an inline literal (not the named
  `ReconcileSummary`, which lacks an index signature for `logger`'s `Fields`).
- **`src/__tests__/pg-integration.test.ts`** — 17 new DB-backed tests. Because the
  node lane aliases `void/env` to an **empty stub** (vite.config), the file now
  `vi.mock`s `void/env` (hoisted mutable `billingConfig`, toggled per test for
  billing-on/off) and `@polar-sh/sdk` (the reconcile network boundary — a stub
  `Polar` whose `subscriptions.list` returns a synthetic `PageIterator`). The
  existing DB-seam tests read no env, so the empty default leaves them untouched.
  Coverage: bigint-mirror round-trip (int8 parity), `checkQuota` at the finite Pro
  ceiling + the D9 expiry re-cap + the billing-OFF unlimited path, `loadTeamBilling`
  free/trial/paid, the trial seed shape + re-cap, reconcile (downgrade / leave-alone
  / **no `billingUpdatedAt` bump** / billing-off no-op), and every webhook writer
  incl. the ordering guard, idempotency, and unresolved-team paths.

**Verification**

- `pnpm --filter @wrightful/dashboard exec vp test run src/__tests__/pg-integration.test.ts`
  — **31 passed** on pglite, and **31 passed against REAL node-postgres** via
  `PG_TEST_URL=postgresql://…@localhost:5433/wrightful_test` (an isolated test DB I
  created in the existing `postgres:16` dev container — NOT `wrightful_dev`, whose
  tables the suite drops/recreates). Confirms the bigint mirror columns round-trip
  as numbers through Drizzle's decoder even where node-postgres returns int8 as
  strings.
- `tsgo --noEmit` exit 0; `vp check` 0 errors / 86 warnings; full lanes — node 197,
  workers 1098.

---

## PR 7 — End-to-end tests (billing-off + login regression) + SELF-HOSTING.md

**What changed**

- **`packages/e2e/tests-dashboard/billing.spec.ts`** — the graceful-OFF path. The
  e2e fixture boots with no `POLAR_*` (`global-setup` sets only
  `WRIGHTFUL_MONITOR_EXECUTOR`), so billing is off. Asserts: the owner-gated
  billing page returns 200 + the "billing is not configured" note + no Upgrade
  button; the Billing nav link is hidden; `POST /api/auth/polar/webhooks` → 404
  (plugin unregistered).
- **`packages/e2e/tests-dashboard/login-regression.spec.ts`** — proves the
  `auth-client.ts` swap (PR 3) didn't break email/password sign-in + session, from
  a clean signed-out context.
- **`SELF-HOSTING.md`** — rewrote "Usage quotas" → "Billing & usage quotas (opt-in
  — OFF by default ⇒ UNLIMITED)": documents `POLAR_*` as the billing switch, the
  three `WRIGHTFUL_PRO_*` caps, that free+Pro caps + trial + UI are cloud-only, and
  cross-references ADR 0002. (Corrected the prior "other tiers are unlimited" line,
  which was wrong post-billing.)

**Verification**

- Monorepo `pnpm check` — 0 errors / 114 warnings (baseline).

**E2E harness fix (pre-existing D1→Postgres gap).** `bootDashboard`
(`packages/e2e/src/dashboard-fixture.ts`) rewrites `.env.local` from scratch and
runs `void db reset` (Step 3, still labelled "Reset local D1"), but the generated
`.env.local` omitted `DATABASE_URL` — and `void` resolves it from `.env.local`,
NOT the inherited `process.env`. So the reset (and `vp dev`) couldn't connect to
Postgres → the whole dashboard e2e suite failed at boot, independent of billing.
Fix: the fixture now forwards `process.env.DATABASE_URL` into the generated
`.env.local` when present (generic — value from the environment, never
hardcoded). With that, `void db reset` **and `vp dev` both boot on Postgres** (the
`vp dev`+pg concern did not reproduce).

- **`DATABASE_URL=…/wrightful_test pnpm --filter @wrightful/e2e test:dashboard --
billing login-regression` → 4 passed** (run against an isolated `wrightful_test`
  DB so `void db reset` never touched `wrightful_dev`; the fixture restored the
  original `.env.local` on teardown). This **confirms Risk #9**: the unregistered
  Polar webhook returns **404** (the spec's assertion holds — not 405/200). Also
  covered: the billing-page off-state note + no Upgrade button, the hidden nav
  link, and the login regression (auth-client swap safe).

### Test-DB note

A `wrightful_test` database was created in the existing local `postgres:16`
container (port 5433) to run the PR 6 real-node-postgres lane safely (isolated
from `wrightful_dev`). It now holds the pg-integration suite's tables — it is the
canonical `PG_TEST_URL` target and can be reused or dropped.

---

## Status / remaining

All seven phases landed on `feature/pg` and pass static checks + unit/integration
tests (workers 1098, node 197, pg-integration 31 incl. real node-postgres) + the
billing-off / login-regression e2e (4 passed; Risk #9 webhook-404 **confirmed**).

**One item remains — deliberately deferred to a real Polar account (cannot be done
here):**

1. **Risk #1 — `referenceId` → `metadata.referenceId` propagation (PR 5 5f), the #1
   integration risk.** Team resolution in every webhook handler + reconcile is
   UNPROVEN until a real Polar **sandbox** checkout confirms the checkout
   `referenceId` lands on the webhook payload's `data.metadata.referenceId`. Set
   billing ON (sandbox `POLAR_ACCESS_TOKEN` + `POLAR_WEBHOOK_SECRET` +
   `POLAR_PRO_PRODUCT_ID`), complete a sandbox checkout for a known `teamId`, and
   inspect the resulting subscription's `metadata` (Polar dashboard event log, or a
   temporary `logger.info` in `onSubscriptionActive`). If `referenceId` does NOT
   propagate, switch the team-carrier strategy (explicit `metadata: { referenceId }`
   on the checkout call, or a `polarCustomerId → teamId` map at first checkout)
   before trusting team resolution.

Also recorded: the trial **no-backfill gap** (PR 4 / Risk #10) for whoever first
switches billing ON on an instance with pre-existing teams.

---

## 2026-06-21 — Sandbox provisioned + billing-UI / checkout-contract coverage

### Sandbox env stood up (Risk #1 is now runnable)

The Polar **sandbox** org `Wrightful` was provisioned so Risk #1 (above) can
finally be exercised against a real checkout:

- **Product** "Wrightful Pro", recurring monthly → `POLAR_PRO_PRODUCT_ID`.
  Created in **GBP (£10)** — the sandbox org's `default_presentment_currency` is
  GBP and Polar rejects a static price omitting it; there is no org-currency API,
  so USD would need a dashboard change. The product _id_ is all checkout needs.
- **Webhook endpoint** (`subscription.active/canceled/revoked`, `order.paid`,
  format `raw`) → `POLAR_WEBHOOK_SECRET`. URL is an **https placeholder**
  (`https://wrightful.example.com/...`; Polar rejects `http`/localhost) — swap for
  a tunnel (`cloudflared tunnel --url http://localhost:5173`) to actually receive
  deliveries; **updating the URL keeps the secret**, creating a new endpoint mints
  a new one.
- **`POLAR_ACCESS_TOKEN`** is a dashboard-minted Organization Access Token (the
  MCP authenticates over OAuth, so no reusable token is derivable from it).
  Validated against `sandbox-api.polar.sh`: `products`/`subscriptions` reads 200,
  bound to org `74d14564-…`. All four `POLAR_*` are in `apps/dashboard/.env.local`.

These live only in `.env.local` (git-ignored); committed config stays generic.

### New tests — `src/__tests__/billing-ui.test.tsx` (9 tests, happy-dom lane)

A coverage audit found the DB-backed suite (`pg-integration.test.ts`) already
covers the mirror state machine, ordering/idempotency, reconcile, quota gating,
and `loadTeamBilling` classification well. Two real gaps remained that local
tests _can_ close — both now covered:

- **ON-path page render** — `billing.tsx` turning a classified state into a CTA
  had zero coverage (the e2e spec only boots billing **off**). Covered: free →
  Upgrade; **trial → Upgrade, NOT Manage** (a trial has no Polar customer, so
  `portal()` would error); paid → Manage + renews-vs-cancels copy; the
  `?checkout=success` "activating" notice gate. Off-state is _not_ re-tested here
  (owned by `billing.spec.ts`).
- **Checkout button contract** — pins `UpgradeButton` → `checkout({ slug: "pro",
referenceId: teamId, … })`. Guards the cross-file invariant that the carrier is
  the team **id** (matching `resolveTeamId` on the webhook) and the slug matches
  the `auth.ts` product map — a `teamId`→`teamSlug` slip or slug rename passes the
  whole handler suite yet silently breaks every upgrade.

**Deliberately skipped** (would be gold-plating): a `resolveBillingProvider` /
`NoopBillingProvider` test — it asserts `enabled ? Polar : Noop` and a constant
return shape. **Out of reach of any local test:** Risk #1's live
`referenceId → metadata.referenceId` round-trip — now a one-time manual gate to
run with the sandbox env above (tunnel → checkout with test card `4242 4242 4242
4242` → confirm the webhook flips the team to `pro`).

### Verification

`vp check` clean on the new file; node lane **206 passed** (was 197, +9).

# ADR 0002 — Billing is an optional, capability-flagged provider (off ⇒ unlimited)

- **Status:** Accepted — design locked, not yet implemented. The implementation spec is `.context/polar-billing-plan.md` (PRs 1–7); this ADR records the durable decision so it isn't re-litigated mid-implementation. A worklog entry per PR is required when the code lands.
- **Date:** 2026-06-20
- **Deciders:** dashboard team

## Context

We are adding a paid **$10/team/month** Pro subscription to Wrightful via the
`@polar-sh/better-auth` plugin (one Polar product, one price), mirroring just
enough subscription state onto the existing `teams` row for synchronous gating.
The full implementation spec lives in `.context/polar-billing-plan.md`.

Wrightful is **MIT-licensed and self-hostable** (see `SELF-HOSTING.md`). The
central risk in adding billing is that it silently degrades the open-source /
self-hosted experience. That risk is concrete, not hypothetical:

- `tierLimits()` (`apps/dashboard/src/lib/usage.ts`) returns the
  `WRIGHTFUL_FREE_*` env ceilings for `tier === "free"` and `Infinity`
  otherwise, with **no billing-enabled guard**. A self-hoster on defaults has
  `teams.tier = "free"`, so they would **silently hit `WRIGHTFUL_FREE_MONTHLY_RUNS`
  (default 1000) + the artifact cap** the moment billing logic ships — even though
  they never opted into a billing model. That is a killed-OSS failure mode.

The codebase already has a settled idiom for optional capabilities, and we want
billing to match it exactly rather than invent a new axis:

- **Capability flags** are pure functions in `apps/dashboard/src/lib/config.ts`
  (`githubOAuthEnabled`, `githubAppEnabled`) that take a `source` env object and
  return `Boolean(...)` over the **presence** of the required keys. They take a
  `source` param because they're read at both config-eval time (`auth.ts`, bare
  Node `process.env`) and request time (loaders, the typed `void/env` proxy).
- **Graceful-no-op** for an optional capability is `email.ts`:
  `isEmailConfigured()` plus a `{ sent: false, reason: "not_configured" }`
  result variant that **never throws when unconfigured** but _does_ throw on a
  real transport failure when configured.
- **Provider seams** are the two-adapter `MonitorExecutor`
  (`apps/dashboard/src/lib/monitors/`): a pure `types.ts` interface, a real
  `sandbox-executor.ts`, a stub `stub-executor.ts`, and an
  `executor-registry.ts` that is the _only_ module importing the concrete
  classes — selected by an env string read at the entry point.

Several existing comments anticipate this work
(`sandbox-policy.ts` — "There is no billing", "until a billing model exists",
"No billing model exists yet"). No `BillingProvider`, `billingEnabled`, or
billing env key exists today — this is a true greenfield seam, so we are
**establishing** the convention, not extending one.

## Decision

**Billing is an optional, capability-flagged provider. Off ⇒ unlimited.**

1. **Off defaults to UNLIMITED, not free-tier caps.** When billing is not
   configured (the OSS / self-host default), **every team is unlimited** — no
   run/testResults/artifact caps, no billing UI, no webhook endpoint. Free-tier
   caps exist **only** when billing is configured (the hosted/cloud deployment).
   Concretely, `tierLimits()` gains a short-circuit at the **top**:
   `if (!billingEnabled(env)) return { runs: Infinity, testResults: Infinity, artifactBytes: Infinity }`,
   _before_ the existing free/non-free logic. (This corrects the plan's earlier
   "unset ⇒ free-tier only" position.)

2. **A single signal: `billingEnabled()`.** One runtime predicate in
   `config.ts`, mirroring `githubAppEnabled()`:
   `billingEnabled(source) = Boolean(source.POLAR_ACCESS_TOKEN && source.POLAR_WEBHOOK_SECRET)`.
   It is the _only_ "is billing on" check — read by the quota short-circuit, the
   billing page/nav, the reconcile cron, and the provider registry. `auth.ts`
   (config-time) inlines the **same** boolean over `process.env` (the same two
   keys) because it cannot import `@/lib/config` in the bare-Node `void prepare`
   context — exactly as it already inlines `githubOAuthEnabled`.

3. **A `BillingProvider` interface seam with a Noop default.** A three-file split
   mirroring the monitor seam, combined with the email graceful-no-op contract:
   `src/lib/billing/types.ts` (pure interface + result types, zero runtime
   imports), `polar-provider.ts` (`PolarBillingProvider` — delegates `reconcile`
   to `reconcile.ts`; imports no SDK itself), `noop-provider.ts`
   (`NoopBillingProvider` — every method a graceful no-op returning
   `{ ok: false, reason: "not_configured" }`, never throwing), and
   `billing-registry.ts` (`resolveBillingProvider(enabled)` — the only module
   importing both concrete classes; the entry point passes `billingEnabled(env)`
   in). The rest of the app depends only on the interface, the `teams` mirror,
   and `billingEnabled()` — **never on Polar directly**. SDK isolation is
   **directory-level**: the `@polar-sh` packages are imported by exactly three
   locations — `auth.ts` (the conditional plugin registration), `auth-client.ts`
   (`polarClient`), and `src/lib/billing/*` (`reconcile.ts` imports the `Polar`
   client; `polar-webhook.ts` imports only erased SDK _types_; `polar-provider.ts`
   imports neither). It is **not** a single-file claim.

4. **The seam is proportional.** The Polar better-auth plugin already abstracts
   checkout / portal / webhook-transport / customer-creation via auth endpoints.
   The `BillingProvider` interface covers **only** the residual app-owned
   operations: reconcile-a-team-from-Polar (the cron) and the webhook-event →
   `teams`-mirror mutation boundary, plus lazy team-customer linking at checkout.
   We do **not** build a heavy abstraction that re-wraps what the plugin already
   does.

5. **Webhook off-state is free.** When billing is off the Polar plugin is not
   registered, so `POST /api/auth/polar/webhooks` does not exist and **404s
   naturally** — no extra gating code is needed.

6. **MIT glue is fine.** Keeping the Polar billing glue MIT is a conscious
   choice. A self-hoster wiring up their own Polar account is a feature, not a
   threat; the moat is operational (we run the maintained hosted instance), not
   the glue. A closed overlay remains available _later_ via the `BillingProvider`
   seam (lift the `src/lib/billing/*` directory together with the `auth.ts`
   plugin registration and the `auth-client.ts` `polarClient()` line — the three
   Polar-importing locations — into a private package, with zero call-site
   changes elsewhere), but is not needed now and must not block.

7. **No `WRIGHTFUL_EDITION` enum.** "Is billing configured?" (`billingEnabled()`)
   is the only signal, matching every other optional feature. A second
   cloud-vs-self-hosted axis would drift out of sync with the real config and
   invite "edition === cloud but billing unconfigured" contradictions. Banned.

## Consequences

- **Self-host is unconditionally unlimited and friction-free.** A deployment
  that never sets `POLAR_*` runs with no caps, no billing nav, a billing page
  that shows only a "not configured — everything is unlimited" note, and a
  404ing webhook. The `tierLimits` short-circuit + `NoopBillingProvider` +
  hidden nav guarantee this.

- **Caps are a cloud-only behavior — and they apply to _both_ tiers.** When
  billing is configured (both `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET`
  present), `free` is capped by `WRIGHTFUL_FREE_*` and `pro` by `WRIGHTFUL_PRO_*`
  — finite, higher than free, enforced by the same quota machinery (soft-warn
  then 429). **Pro is NOT unlimited; only the billing-off / self-host path is.**
  `SELF-HOSTING.md` documents both the `WRIGHTFUL_FREE_*` and `WRIGHTFUL_PRO_*`
  caps as cloud-only.

- **One place interprets tiers; one signal gates billing.** Enforcement, UI, and
  plugin registration can't drift — they all read `billingEnabled()` (or its
  one inline config-time twin in `auth.ts`).

- **Polar is isolated behind the seam (directory-level).** The `@polar-sh`
  packages are imported by exactly three locations: `auth.ts` (conditional plugin
  registration), `auth-client.ts` (`polarClient`), and `src/lib/billing/*`
  (`reconcile.ts` imports the `Polar` client; `polar-webhook.ts` imports only
  erased SDK _types_; `polar-provider.ts` imports neither). Pure/unit-test code
  imports `types.ts` and the Noop without pulling in the runtime. This both
  enables the clean self-host no-op and keeps a future closed overlay a drop-in
  (move the `src/lib/billing/*` directory plus the `auth.ts`/`auth-client.ts`
  wiring as a unit).

- **The ingest quota read now considers `currentPeriodEnd`** (via `effectiveTier`)
  rather than `tier` alone — a deliberate, small change so a lost
  `subscription.revoked` self-heals once the paid-through date passes (D9). This
  is inert when billing is off (the short-circuit returns unlimited regardless).

- **Tests must exercise both billing states.** `tierLimits` is asserted with
  billing OFF (all-`Infinity`) and ON (free **and** finite Pro ceilings) in the
  workers + pg lanes; the off-state webhook 404 and hidden-nav are covered by e2e. The exact
  per-test env-override ergonomics are an implementation detail flagged in the
  plan.

- **Cost of the seam.** Four small billing files + a one-line short-circuit +
  one capability flag, versus a single inlined `if (env.POLAR_*)` everywhere.
  Accepted: it's the same shape as the monitor and email seams the team already
  maintains, and it's what makes the OSS guarantee and the future-overlay option
  cheap.

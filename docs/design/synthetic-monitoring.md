# Synthetic Monitoring — Design & Implementation Plan

> Status: planned (2026-06-07). Substrate decision: **Void Sandbox** (Cloudflare
> Containers + Sandbox SDK). v1 scope: **browser checks core**, schema designed
> so HTTP/TCP uptime + retries/alerting slot in later.

## Context

Wrightful today ingests Playwright **CI runs** via `@wrightful/reporter`. This
adds a second source of runs: **synthetic monitors** — user-authored Playwright
tests that we execute _on a schedule_ (Checkly-style), so users learn their app
broke before a customer does. Users paste a real `*.spec.ts` into an in-app
editor, pick an interval, and we run it every N minutes and stream the result
into the run pipeline they already use.

The module is designed generically (a `Monitor` with a `type` discriminator) so
the later **uptime monitoring** family (HTTP/TCP/ping — no browser) reuses the
same scheduling, execution-record, and alerting plumbing; only the executor
differs.

### Why this substrate (decision record)

- **Cloudflare Browser Run alone is not enough.** It provides a remote sandboxed
  _browser_, but the Playwright _driver script_ runs in a Worker isolate. Two
  blockers: (1) Workers can only run the Playwright _library_ + `expect()`, **not
  the `@playwright/test` runner** (no `test()`/fixtures/projects) — users could
  not paste a real spec file; (2) running untrusted tenant code in our Worker is
  RCE against our control plane.
- **Void Sandbox** (`void/sandbox` → Cloudflare Containers + Sandbox SDK, GA
  underneath) runs the **real `@playwright/test` runner** inside a **per-run
  VM-isolated container** with a real browser baked into the image. It runs the
  user's actual spec, with the strongest isolation, and — critically — a
  container that runs `playwright test` with `@wrightful/reporter` streams
  results into the **existing `/api/runs` ingest unchanged**. A synthetic
  execution simply _is_ a `run`.
- Cost: active-CPU billing makes a check ≈ $0.0012/run (≈10× cheaper than a
  GitHub Actions job for short checks). Per-tenant interval + concurrency quotas
  keep it bounded.
- Known limitation: Cloudflare can't pick a browser region → **no multi-location
  in v1** (would need an external runner later).

## Architecture

```
                         ┌─ crons/sweep-monitors.ts  (cron "* * * * *")
                         │    sweepDueMonitors(): select enabled monitors where
                         │    nextRunAt<=now (bounded), advance nextRunAt + create
                         │    a 'queued' monitorExecution + enqueue, all in one D1 batch
                         ▼
        queues/monitors.ts  (defineQueue<{monitorId,executionId,scheduledFor}>)
                         │    consumer: load monitor+execution (scope by projectId),
                         │    mark running, dispatch to MonitorExecutor, record result.
                         │    observed-fail → ack + record; infra-error → msg.retry()
                         ▼
        MonitorExecutor (interface)
          ├─ SandboxExecutor (prod): getSandbox(executionId) → writeFile spec +
          │    generated playwright.config (reporter wired) → exec `npx playwright
          │    test` with env (WRIGHTFUL_URL/TOKEN/IDEMPOTENCY_KEY/MONITOR_ID/ORIGIN)
          │    → reporter streams into /api/runs as a run (origin='synthetic')
          └─ StubExecutor (dev/test): synthesizes a run via the ingest lib, no
               container. Selected by WRIGHTFUL_MONITOR_EXECUTOR=stub.
                         ▼
        Existing ingest pipeline (openRun/appendRunResults/completeRun) + R2
        artifacts + the void/ws run room — all reused verbatim.
```

**Linking:** the executor pre-opens the run via the reporter's exported
`StreamClient.openRun` (idempotencyKey = executionId, monitorId, origin), stores
the returned `runId` on `monitorExecutions.runId`, then launches `playwright test`
with the **same** idempotencyKey so the in-container reporter attaches to that run.

## Data model (new migration via `void db generate`)

New tables in `apps/dashboard/db/schema.ts` (follow existing conventions: ULID
text PK, epoch-second integer timestamps, denormalized `teamId`/`projectId`,
explicit named indexes, `$inferSelect` type aliases):

- **`monitors`** — the definition.
  `id, teamId(FK→teams cascade), projectId(FK→projects cascade), name, type
('browser' v1; reserve 'http'|'tcp'|'ping'), enabled(int default 1), source
(Playwright spec text), config(JSON text), intervalSeconds, schedulingStrategy
(default 'round_robin'), retryConfig(JSON text, reserved), nextRunAt(epoch sec,
null=paused), lastEnqueuedAt, lastRunAt, lastStatus, createdBy(userId),
createdAt, updatedAt`.
  Indexes: `uniqueIndex(projectId,name)`, `index(projectId,createdAt)`,
  `index(enabled,nextRunAt)` (the sweep seek path).
- **`monitorExecutions`** — one row per scheduled attempt.
  `id, projectId(FK→projects cascade), monitorId(FK→monitors cascade),
scheduledFor, startedAt, completedAt, state (queued|running|pass|degraded|fail|
error), attempt(int default 0), runId (logical ref to runs.id, nullable),
durationMs, errorMessage, createdAt`.
  Indexes: `index(monitorId,createdAt)`, `index(projectId,createdAt)`.

Extend **`runs`**:

- `monitorId text` — **logical FK** (no `.references()`, to avoid a runs↔monitors
  FK cycle; matches the existing `memberships.userId` logical-FK precedent).
- `origin text NOT NULL DEFAULT 'ci'` — `'ci' | 'synthetic'`. Existing rows
  default to `'ci'`; analytics can include/exclude synthetic.

**Migration note:** the new FK-cascade tables will trip Void's `isDestructive()`
false-positive (same as `0000`); add the `-- void:allow-destructive` pragma.
Safe — the dashboard has not deployed and there are zero users. Never edit the
existing applied migration (frozen-migration rule).

## Wire contract (keep both sides in sync)

`apps/dashboard/src/lib/schemas.ts` `RunMetaCommon` + `packages/reporter/src/types.ts`

- `packages/reporter/src/payload.ts` gain optional:

* `monitorId: string | null` and `origin: 'ci' | 'synthetic'`.
  The reporter reads `WRIGHTFUL_MONITOR_ID` / `WRIGHTFUL_RUN_ORIGIN` /
  `WRIGHTFUL_IDEMPOTENCY_KEY` env (override) into the open-run payload.
  `packages/reporter/src/__tests__/contract.test.ts` is updated to keep the canary
  green.

## Modules

| Path                                                                                        | Responsibility                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/monitors/types.ts`                                                                 | `Monitor`, `MonitorExecution`, `MonitorExecutor` interface, `ExecutionResult`, `ExecutionState`                                                                                                                          |
| `src/lib/monitors/monitor-schemas.ts`                                                       | Zod create/edit schemas (name, type, source, intervalSeconds preset, enabled)                                                                                                                                            |
| `src/lib/monitors/monitors-repo.ts`                                                         | Tenant-scoped CRUD (consumes `TenantScope`; mirrors `scope.ts` `runByIdWhere` style)                                                                                                                                     |
| `src/lib/monitors/scheduler.ts`                                                             | `sweepDueMonitors({ now, limit })` — bounded select + advance + enqueue (modeled on `sweepStaleRuns` in `ingest.ts`)                                                                                                     |
| `src/lib/monitors/executor.ts`                                                              | `resolveExecutor(env)` → Sandbox or Stub; `runMonitorExecution()` orchestration shared by queue consumer                                                                                                                 |
| `src/lib/monitors/sandbox-executor.ts`                                                      | `getSandbox` + writeFile spec/config + `exec` playwright; generated `playwright.config` template; synthetic ingest-token provisioning                                                                                    |
| `src/lib/monitors/stub-executor.ts`                                                         | Deterministic in-process executor for dev/test (synthesizes a run via ingest lib)                                                                                                                                        |
| `crons/sweep-monitors.ts`                                                                   | `export const cron="* * * * *"` + `defineScheduled` thin adapter over `sweepDueMonitors`                                                                                                                                 |
| `queues/monitors.ts`                                                                        | `defineQueue<MonitorJob>` consumer; ack vs `retry()` discipline                                                                                                                                                          |
| `pages/t/[teamSlug]/p/[projectSlug]/monitors/{index,new,[monitorId]/index}.{tsx,server.ts}` | List / create / detail+edit (detail deep-links browser executions to `/runs/[runId]`)                                                                                                                                    |
| `src/components/ui/code-editor.tsx`                                                         | CodeMirror 6 client island (`@uiw/react-codemirror` + `@codemirror/lang-javascript`)                                                                                                                                     |
| `src/components/app-layout.tsx`                                                             | add `"monitors"` `NavId` + nav item in `AppSidebarMiddle` + `deriveActiveNav` regex                                                                                                                                      |
| `env.ts`                                                                                    | `WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE`(200), `WRIGHTFUL_MONITOR_MAX_PER_PROJECT`(25), `WRIGHTFUL_MONITOR_MIN_INTERVAL_SECONDS`(60), `WRIGHTFUL_MONITOR_EXECUTOR`('sandbox'), `WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS`(300) |
| `void.json`                                                                                 | `sandbox` block: custom Playwright Dockerfile, `instanceType`, `maxInstances`                                                                                                                                            |
| `Dockerfile.sandbox` (dashboard)                                                            | Microsoft Playwright base image + `@wrightful/reporter` preinstalled                                                                                                                                                     |

### Key reuse

- Scheduler ≈ `sweepStaleRuns`/`drainStaleRuns` (bounded select → bounded-concurrency drain) — `src/lib/ingest.ts`.
- Tenant scope: `TenantScope`, `makeTenantScope`, `requireTenantContext` — `src/lib/scope.ts`, `tenant-context.ts`.
- Page pattern: `defineHandler` loader + co-located `.server.ts`; nav in `app-layout.tsx`; ~55 `ui/` components.
- Ingest + realtime + R2 artifacts: untouched — synthetic runs flow through them as-is.
- Reporter `StreamClient` (already exported) for pre-opening the run.

## Security (v1 minimums, hardening backlog)

- Untrusted code runs **only** in the sandbox container (never our Worker). Never `eval` user code.
- Per-tenant quotas: `MAX_PER_PROJECT`, `MIN_INTERVAL_SECONDS`, `maxInstances`, per-run `MAX_DURATION_SECONDS`.
- Synthetic ingest token: a dedicated project-scoped API key (lazily provisioned, reuse `api-key.ts`), passed to the container — never our session secrets.
- **Backlog (documented, not v1):** egress allowlist / SSRF guard (reject RFC1918, `169.254.169.254`, loopback; pin resolved IP) for browser navigation; encrypted per-monitor secrets via gateway/JWT injection; artifact secret-scrubbing.

## Testing

- **Unit (vitest, `vp test`)** — runnable here:
  - `scheduler.test.ts` — due-selection, `nextRunAt` advancement, double-fire idempotency, batch bound.
  - `queue-consumer.test.ts` — observed-fail→ack vs infra-error→retry, with `StubExecutor`.
  - `monitor-schemas.test.ts` — validation (interval presets, required fields, size caps).
  - `config-gen.test.ts` — generated `playwright.config` content + env wiring.
  - `monitors-repo.test.ts` — scoped CRUD; cross-tenant denial.
  - `contract.test.ts` (reporter) — `monitorId`/`origin` round-trip.
- **E2E (Playwright, `packages/e2e/tests-dashboard/monitors.spec.ts`)** — models `api-keys.spec.ts`:
  create a monitor via the editor form → assert listed → trigger scheduler+queue
  (dev `/__void/scheduled` + `/__void/queue`) with `WRIGHTFUL_MONITOR_EXECUTOR=stub`
  → assert an execution appears and links to a run. Stub executor avoids needing
  Docker/containers in CI.
- **Integration (needs user env, not automatable here):** real `void dev`/deploy
  with Docker → SandboxExecutor runs `npx playwright test` in a real container and
  streams a real run. Documented as a manual verification step.

## Verification

1. `pnpm install && pnpm --filter @wrightful/dashboard exec void prepare`
2. `pnpm --filter @wrightful/dashboard exec void db generate` (new migration) — review SQL, add allow-destructive pragma.
3. `pnpm check` (fmt + lint + type-check) — green.
4. `pnpm --filter @wrightful/dashboard test` + `pnpm --filter @wrightful/reporter test` — green.
5. `pnpm --filter @wrightful/e2e test:dashboard` — monitors.spec passes (stub executor).
6. Manual (user): `pnpm dev`, create a browser monitor, confirm a real container run streams in.

## Out of scope for v1 (designed-for, built later)

Uptime (HTTP/TCP/ping) executor; retries/anti-flapping block; alert channels
(email/Slack/webhook); multi-location; degraded-state helper library;
sub-minute intervals (needs Durable Object alarms).

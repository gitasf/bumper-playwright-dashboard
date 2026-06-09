# 2026-06-07 — Synthetic monitoring (browser checks), v1

## What changed

Added a **synthetic monitoring** module: users author a Playwright `*.spec.ts` in
an in-app editor, pick an interval, and the dashboard runs it on a schedule and
streams the result into the existing run pipeline. A scheduled "browser monitor"
execution simply **is** a `run` (`origin = 'synthetic'`, tagged with its
`monitorId`), so the entire run/test/artifact UI, `void/live` realtime, and
analytics are reused unchanged.

Execution substrate is **Void Sandbox** (`void/sandbox` → Cloudflare Containers +
Sandbox SDK): the user's real `@playwright/test` spec runs in a per-execution
VM-isolated container with `@wrightful/reporter` baked in, which streams a run
back to `/api/runs`. The full decision record (why not Browser Run / Worker
Loader; cost vs GitHub Actions; SSRF/secrets backlog) is in
`docs/design/synthetic-monitoring.md`.

Designed generically (a `Monitor` with a `type` discriminator; `'browser'` in
v1, `'http'|'tcp'|'ping'` reserved) so the later Checkly-style **uptime
monitoring** family reuses the scheduler + execution record + (future) alerting
with only a different executor.

## Details

| Area                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema (`db/schema.ts`) | New `monitors` + `monitorExecutions` tables; `runs.origin` (`'ci'`\|`'synthetic'`, default `'ci'`) + `runs.monitorId` (logical FK, avoids a runs↔monitors cycle). Migration `20260607170319_watery_mimic.sql` (+ `-- void:allow-destructive` pragma for the FK-cascade false-positive; safe pre-deploy).                                                                                                                                                                                         |
| Wire contract           | `RunMetaCommon` (`src/lib/schemas.ts`) + reporter `types.ts`/`payload.ts` gain optional `origin` + `monitorId`. Reporter reads `WRIGHTFUL_IDEMPOTENCY_KEY` / `WRIGHTFUL_MONITOR_ID` / `WRIGHTFUL_RUN_ORIGIN` env so a containerized run attaches to a specific execution. `contract.test.ts` extended.                                                                                                                                                                                           |
| Env (`env.ts`)          | `WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE`(200), `_MAX_PER_PROJECT`(25), `_MIN_INTERVAL_SECONDS`(60), `_EXECUTOR`(`'sandbox'`), `_MAX_DURATION_SECONDS`(300).                                                                                                                                                                                                                                                                                                                                          |
| Scheduling              | `crons/sweep-monitors.ts` (cron `* * * * *`) → `sweepDueMonitors` (bounded select of `enabled=1 AND nextRunAt<=now`, advance `nextRunAt` + insert `queued` executions in ONE D1 batch BEFORE enqueue → no double-fire; bounded-concurrency enqueue). Pure `planMonitorSweep` is unit-tested. Modeled on `sweepStaleRuns`.                                                                                                                                                                        |
| Queue                   | `queues/monitors.ts` — `defineQueue<MonitorJob>` (IDs only, <128KB). Thin adapter over the PURE `runMonitorJob` (ack/retry contract). `maxBatchSize=5`, `maxRetries=2`.                                                                                                                                                                                                                                                                                                                          |
| Executors               | `executor.ts` (pure `runMonitorJob`, DI), `executor-registry.ts` (`resolveExecutor`), `stub-executor.ts` (dev/test, no container), `sandbox-executor.ts` (prod: `getSandbox` → writeFile spec+config → `npx playwright test` → resolve run by idempotencyKey; mints + deletes a per-run ingest key; **`sandbox.destroy()`** on teardown), `run-linking.ts`, `synthetic-key.ts`, `playwright-config.ts` (pure, unit-tested).                                                                      |
| Data layer              | `monitors-repo.ts` — tenant-scoped CRUD (branded `TenantScope`) + system-internal execution lifecycle (trusted-row scoping, like `finalizeStaleRun`). `types.ts`, `monitor-schemas.ts`.                                                                                                                                                                                                                                                                                                          |
| UI                      | `pages/t/[teamSlug]/p/[projectSlug]/monitors/{index,[monitorId]}` — list, and the `[monitorId]` route serves BOTH detail (edit/enable/delete) AND the create form via a reserved `"new"` sentinel (see routing note below); browser executions deep-link to `/runs/<runId>`. New `src/components/ui/code-editor.tsx` (CodeMirror 6 client island w/ SSR-safe `<textarea>` fallback). "Monitors" nav entry in `app-layout.tsx`. New deps `@uiw/react-codemirror` + `@codemirror/lang-javascript`. |
| Deploy artifact         | `apps/dashboard/Dockerfile.sandbox` (extends `docker.io/cloudflare/sandbox:0.10.2` + Chromium-only + published `@wrightful/reporter`) + `.dockerignore`, wired via `void.json#sandbox`. Makes Docker required for `vp dev`. See the "WIRED IN" update at the bottom.                                                                                                                                                                                                                             |
| Tests                   | Unit (vitest): `scheduler` (pure planner), `executor` (ack/retry branches), `playwright-config` (gen). Reporter `contract` extended. E2E: `packages/e2e/tests-dashboard/monitors.spec.ts` (+ `pages/monitors.page.ts`, `helpers/dev-trigger.ts`, fixture `extraEnv`/`devTriggerToken` support) — create→list→schedule→execute via the stub executor, no Docker.                                                                                                                                  |

## Key design decisions

- **Pure/runtime split** so unit tests work under the vitest harness (which runs
  without the void plugin: `void/db` is a throwing stub; `void/queues`,
  `void/sandbox`, `void/env` don't resolve). Decision logic (scheduler planning,
  ack/retry, config-gen) is pure + DI'd; DB/queue/sandbox modules are
  integration-only.
- **Linking:** the in-container reporter opens the run with
  `idempotencyKey = execution.id`; the executor resolves `runId` by that key.
- **Per-run ingest key** is minted then HARD-deleted (not soft-revoked) — single
  use, no audit value, avoids one `apiKeys` row per execution forever.
- **`destroy()` on teardown** so the container scales to zero immediately
  (otherwise ~10 min idle billing per ~45s check).

## Verification

- `pnpm check` (fmt + lint + type): **0 errors** (88 pre-existing warnings, none monitor-related).
- `tsgo --noEmit`: **0 errors**.
- Dashboard vitest: **624 passed** (incl. 20 monitor tests). Reporter vitest: **197 passed** (incl. contract canary).
- Migration generated via `void db generate` + reviewed.

### Not verifiable in this environment (need a real runtime)

- **Live container execution** (SandboxExecutor) — needs Docker + a built/pushed Playwright image.
- **E2E run** — spawns `void dev` (deferred to the user per the no-dev-server convention).

## Go-live (enable real, non-stub execution)

1. Build + push the sandbox image (see `Dockerfile.sandbox` header for exact commands; vendors the unpublished reporter via `npm pack`).
2. Add to `apps/dashboard/void.json`:
   ```json
   "sandbox": {
     "image": "./Dockerfile.sandbox",
     "platformImage": "<registry>/wrightful-sandbox:latest",
     "instanceType": "standard-2",
     "maxInstances": 20
   }
   ```
   (Left out of `void.json` deliberately: `image` triggers a local image build on `vp dev`, which would change the `pnpm dev` / e2e-boot workflow. Dev/test use `WRIGHTFUL_MONITOR_EXECUTOR=stub`.)
3. `void deploy` (applies the migration + provisions the SANDBOX DO/container).
4. Run the e2e: `pnpm --filter @wrightful/e2e test:dashboard monitors.spec.ts`.

## Update (same day) — `/monitors/new` 404 → routing precedence fix

`/monitors/new` 404'd. Root cause: **Void's page matcher has no static-over-dynamic
precedence for routes nested under a dynamic segment.** `scan-2YmJkYAf.mjs` only
de-prioritizes a route as "dynamic" if its WHOLE pattern contains `:`; both
`/t/:teamSlug/p/:projectSlug/monitors/new` and `…/monitors/:monitorId` do (via
`:teamSlug`), so the tie-break falls to `localeCompare(pattern)`, where
`:monitorId` (`:` = 0x3A) sorts before `new` (`n`) → the detail route shadows
`new` → `getMonitor("new")` → null → 404. (`/settings/teams/new` works only
because its pattern has no parent params, so the static-first rule applies.)

**Fix:** merged the create form INTO the `[monitorId]` route (which is what
actually receives `/monitors/new`). The loader returns a `mode`-discriminated
union — `monitorId === "new"` → create mode, else detail — and `createMonitor`
joined the route's named `actions` (invoked via `?createMonitor`, the same
`?action` convention the detail forms already use). Deleted `new.{tsx,server.ts}`.
Both URLs (`/monitors/new`, `/monitors/[monitorId]`) and all existing links/e2e
are unchanged; monitor ids are ULIDs so none can collide with the `"new"`
sentinel. Verified green (typecheck 0, check 0, 624 + 197 tests).

**Gotcha for future routes:** do NOT place a static page as a direct sibling of a
`[param]` route under a dynamic-ancestor path — the param shadows it. Either
nest the dynamic route under a static prefix, or have the `[param]` route handle
the reserved word.

## Follow-ups (designed-for, not built)

Uptime (HTTP/TCP/ping) executor; retries/anti-flapping + alert channels; egress
allowlist/SSRF guard + encrypted per-monitor secrets (security backlog in the
design doc); filter `synthetic-monitor:` keys from the API-keys settings list;
sub-minute intervals (Durable Object alarms); multi-location (external runner).

## Update (same day) — dev-boot friction, substrate verdict, then WIRED IN

**Friction found:** running `pnpm setup:local` (`vp dev`) failed at boot —
`∷ Building container images for local development… Docker build exited with
code 1`. Root cause (verified against `void@0.9.2`'s `plugin-inference`): Void
infers the `SANDBOX` binding from **any** `void/sandbox` import in a scanned
`src` file (`needsSandbox = true`), then `@cloudflare/vite-plugin` builds the
sandbox image on every local `vp dev` (Docker required, image cached after first
build). The boot failed because no custom image was configured, so it fell back
to the **Sandbox SDK's default image**, whose build is broken in this workspace
(the SDK's own `turbo prune @repo/sandbox-container` step). There is no
first-class dev opt-out — the import alone triggers the build.

**Substrate verdict (researched + adversarially verified):** Containers are
**NOT the fastest** substrate (a Worker Loader V8 isolate boots in ms; Fly.io
Firecracker microVMs sub-second; containers are ~1–3s, image-size dependent) but
they ARE the **most suitable** — the only option satisfying all four hard
constraints at once: real `@playwright/test` runner, hardware-VM-grade isolation
for untrusted code, Cloudflare/Void-native (one bill), and zero change to the
reporter→`/api/runs` pipeline. Every faster substrate sacrifices one: Worker
Loader / Browser Run can't run the test runner (and weaken isolation); Fly.io
keeps both but leaves the platform. **For a 1–10 min background monitor, a 1–3s
cold start is invisible** — "fastest" is the wrong axis; "most suitable" wins.

**The real lever is lifecycle, not substrate** (future tuning):

- Replace `destroy()`-per-run with cadence-tuned `sleepAfter`/`keepAlive` +
  reconnect by `getSandbox(id)` so tight-cadence monitors pay cold start once,
  not per run. Keep destroy-per-run only for sparse cadences (warm idle billing
  can exceed a cold start there). Make it a per-monitor, cadence-driven choice.
- Pre-warm just-in-time (cron knows the next tick) and right-size the instance.
- The reporter→`/api/runs` HTTP seam means a future substrate swap (e.g. Fly.io,
  if multi-location becomes a requirement) is a runner-host change, not a
  data-plane change — a reason to stay on containers now, not leave.

**Resolved — WIRED IN (chose option a: containers, Docker-for-dev):**

- Un-parked `sandbox-executor.ts`; `executor-registry.ts` resolves non-`"stub"`
  to the real `SandboxExecutor` again. `inferProjectBindings()` → `needsSandbox:
true`.
- `void.json#sandbox` now points at `./Dockerfile.sandbox`
  (`instanceType: standard-2`, `maxInstances: 20`). `platformImage` is a
  placeholder — replace with a real pushed registry ref before `void deploy`.
- **`Dockerfile.sandbox` rewritten slim**: extends
  `docker.io/cloudflare/sandbox:0.10.2` (REQUIRED — the base provides the control
  server + ENTRYPOINT the SDK's `getSandbox()/exec()/writeFile()` talk to; version
  must match the `@cloudflare/sandbox` npm package; do NOT override ENTRYPOINT),
  then adds Chromium-ONLY via `playwright install --with-deps chromium` (not the
  ~2 GB all-browser MS image). The reporter is a **published, zero-runtime-dep
  npm package** (`@wrightful/reporter@0.1.1`) so it `npm install`s normally — no
  workspace vendoring. Added `apps/dashboard/.dockerignore` (tiny context; keeps
  `.env.local` out of the build).
- **Consequence:** `pnpm dev` now requires Docker (Desktop/Colima) running — the
  image builds once on first boot, then caches (`[r]` to rebuild). Set
  `WRIGHTFUL_MONITOR_EXECUTOR=stub` to run dev without exercising the container.
- **Local test loop:** Docker running → `pnpm dev` → create a browser monitor →
  the cron (`/__void/scheduled` in dev) + queue run it in a real local container
  → a synthetic run streams into the run UI.
- **Not verifiable here** (no Docker in this env): the actual image build + a
  live container run. The wiring, types, lint, and unit/contract tests are green
  (`pnpm check` 0 errors; dashboard 624; reporter 197).

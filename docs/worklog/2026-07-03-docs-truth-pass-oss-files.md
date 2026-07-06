# 2026-07-03 — Docs truth pass + OSS files + Tier-A comment sweep (P3-docs, P3-comments)

## What changed

Documentation accuracy + open-source readiness from the 2026-07-03 review.

### Docs truth pass (P3-docs)

- **`docs/ARCHITECTURE.md`**: corrected the R2 bullet — it denied the direct-R2
  presign path that shipped; now describes the worker-proxied default AND the
  opt-in `r2DirectEnabled()` SigV4 path (cross-links ADR-0003). Bumped "Six
  crons" → "Seven" and added the `reconcile-billing` cron (daily 04:30 UTC);
  noted the offset 5-minute reaper expressions; added `rollup-usage` time. Added
  Polar billing + direct-R2 `R2_*` to the Configuration env groups (ADR-0002).
- **`SELF-HOSTING.md`**: fixed the retention table — `WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE`
  default `200 → 1000` with the corrected "chunk size per drain iteration"
  semantics, and added the two missing knobs (`WRIGHTFUL_RETENTION_SWEEP_BUDGET_MS`,
  `WRIGHTFUL_RETENTION_SWEEP_MAX_CHUNKS`, matching env.ts). Added a **Usage quotas
  & billing (optional, Polar)** subsection documenting `POLAR_*` + `WRIGHTFUL_FREE_*`
  / `WRIGHTFUL_PRO_*` / `WRIGHTFUL_QUOTA_SOFT_WARN_PCT` and the billing-off ⇒
  unlimited default.
- **root `CLAUDE.md`**: qualified `db:generate` / `deploy:cf` / `db:migrate:remote`
  as **apps/dashboard** scripts (run via `--filter @wrightful/dashboard`) — they
  don't exist at the repo root.

### OSS files

- Added **`SECURITY.md`** (the most consequential gap — there was no
  vulnerability-reporting channel): private reporting via GitHub Security
  Advisories, scope, supported-versions, and the security model context.
- Added **`CONTRIBUTING.md`** (dev loop, `vp check`/`vp test` gates, DB-migration
  workflow, the worklog requirement, monorepo layout) and **`CODE_OF_CONDUCT.md`**
  (Contributor Covenant 2.1).
- Added `.github/PULL_REQUEST_TEMPLATE.md` and `.github/ISSUE_TEMPLATE/`
  (bug_report, feature_request, config.yml routing security reports away from
  public issues).

### Tier-A comment sweep (P3-comments — the misdirecting ones)

- `db/schema.ts`: the `runs.teamId` doc pointed realtime authz at a **nonexistent
  `src/live.ts`** — repointed to `authorizeTopicSubscription` (`src/lib/authz.ts`)
  wired into `routes/ws/run/[runId].ws.ts`.
- `src/lib/artifacts.ts`: removed stale **D1** references (the `MAX_IN_ARRAY_IDS`
  "D1 caps at 100" rationale, "under D1's cap/limit", "fetched from D1", "the D1
  rows are gone"), fixed "SQLite treats NULLs as distinct" → **Postgres**, and
  corrected the module docstring that still claimed "no S3-style presign" (the
  direct-R2 path shipped).
- `routes/api/.../keys.ts`: removed the backwards "SQLite `LIKE` is
  case-insensitive" rationale (Postgres `LIKE` is case-SENSITIVE; the guard folds
  case in JS).
- Deleted `apps/dashboard/todo.md` (a superseded pre-Postgres design doc
  contradicting the current architecture).
- Also committed the source review under `docs/reviews/`.

## Notes / follow-ups

The broader Tier-B/C `D1`→`Postgres` comment drift (~25 more cosmetic mentions
across analytics / ingest / monitors — enumerated in the review) is deferred as a
low-risk mechanical follow-up; the actively-misdirecting Tier-A set is fixed here.

## Verification

- `pnpm check` — 0 errors (docs + comment-only changes).

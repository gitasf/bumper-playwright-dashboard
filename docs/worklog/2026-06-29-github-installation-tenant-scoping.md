# 2026-06-29 — Fix cross-tenant GitHub App installation confused-deputy

## What changed

A security audit of the codebase surfaced one HIGH-severity cross-tenant
authorization flaw in the GitHub App check-run integration. This worklog records
the vulnerability and the two-part fix.

### The vulnerability

The dashboard posts GitHub **check runs** (which can gate PR merges) on behalf of
a connected GitHub App installation. Two trust-boundary gaps let one tenant act
through _another_ organization's installation:

1. **Unscoped installation lookup (primary, `src/lib/github-checks.ts`).**
   `maybePostGithubCheck` selected the installation to use with
   `where(eq(githubInstallations.accountLogin, owner))`, where `owner` is parsed
   from `run.repo` — a free-text, length-only-validated **ingest field**
   (`schemas.ts:150`, persisted to `runs.repo`). The run's own `teamId` was never
   compared against the installation's `teamId`. So any tenant holding an API key
   for any project could ingest a run with `repo: "victimorg/private-repo"`,
   complete it, and cause the dashboard to mint **victimorg's** installation token
   and POST a check run (with attacker-influenced title / markdown summary /
   `details_url`) to victimorg's repositories — a confused deputy across the
   tenant boundary. Triggered on every completed run via `completeRun` /
   `finalizeStaleRun`, with no team gate.

2. **Blind installation repoint at link time (`routes/api/github/setup.ts`).**
   The GitHub App "Setup URL" callback persisted the installation→team link with
   `insert(...).onConflictDoUpdate({ target: installationId, set: { teamId } })`.
   `installation_id` is an enumerable, sequential integer supplied in the query
   string, and the callback only verified the user owns the team named in the
   plaintext `state` slug (their _own_ team). The `onConflictDoUpdate` keyed on
   `installationId` therefore **repointed an already-connected installation's
   `teamId` to the attacker's team** (the `accountLogin` unique index does not
   block an in-place update of the same row), letting an attacker steal a
   victim's connected installation with a single request.

Impact: write merge-gating status checks and arbitrary markdown / a `details_url`
link (phishing vector) into a victim org's PR/checks UI, using the victim's own
GitHub App installation token.

The webhook signature verification itself (`verifyWebhookSignature`) is sound —
raw-body HMAC-SHA256, constant-time compare, required header/secret. The flaw was
the unverified trust placed in the ingest-supplied `repo` owner (sink) and the
enumerable `installation_id` (link).

### The fix

1. **Scope the sink to the run's team** (`src/lib/github-checks.ts`). The
   installation lookup now filters on `teamId AND accountLogin`:
   `and(eq(githubInstallations.teamId, run.teamId), eq(githubInstallations.accountLogin, owner))`.
   A run may only drive the installation **its own team** connected, so naming
   another org's repo resolves no installation and no-ops. This is the core
   authorization fix that eliminates the cross-tenant confused deputy.

2. **Never repoint a foreign team's installation** (`routes/api/github/setup.ts`).
   The callback now looks up any existing link for the `installation_id` first:
   if it belongs to a **different** team, it refuses (user-facing "already
   connected to another team" message) instead of stealing it; if it belongs to
   the **same** team, it idempotently refreshes the row; otherwise it inserts
   (with the `accountLogin` unique-violation path preserved for the
   different-installation-same-org case).

## Details

| File                                        | Change                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/github-checks.ts`   | Import `and`; select `runs.teamId`; scope installation lookup to `teamId AND accountLogin`; docstring/comments updated.                      |
| `apps/dashboard/routes/api/github/setup.ts` | Import `eq`; replace blind `onConflictDoUpdate` with read-then-write that refuses cross-team repoint and stays idempotent for the same team. |

No schema, migration, dependency, or config changes. Wire contract unchanged.

## Known residual / follow-up

These fixes fully close the primary cross-tenant abuse (unscoped sink) and the
repoint hijack. One narrower residual remains: an attacker could still
**land-grab an installation that exists but is not yet linked** by racing the
setup callback with a guessed `installation_id` and their own team slug as
`state` (the automatic post-install redirect window). Fully closing this requires
proving the linking user controls the GitHub account — the canonical
`GET /user/installations` check — which is **not feasible with the current auth
config**: the GitHub OAuth provider (`auth.ts`) requests only `user:email` scope
and is a separate credential from the GitHub _App_. Recommended follow-up: record
the signed `installation.created` webhook's `sender.login` and cross-check it
against the linking user's mirrored `userGithubAccounts.githubLogin` before
persisting the link (or expand OAuth scope + unify with the App and verify via
the installations API). Tracked as a separate hardening task; the
land-grab is far narrower than the now-closed primary paths.

## Verification

- `void prepare && tsgo --noEmit` (dashboard typecheck) — **clean, no errors**.
- `vp check` (format + lint) on both changed files — **0 errors**, correctly
  formatted. (One pre-existing `no-unsafe-type-assertion` _warning_ remains on the
  untouched `postCheckRun` JSON cast at `github-checks.ts:119` — not introduced
  by this change.)
- `vp test run -c vitest.workers.config.ts` for `github-checks` +
  `ingest-pipeline` — **16 tests pass**. The ingest-pipeline suite mocks
  `void/env` to `{}`, so `maybePostGithubCheck` no-ops before any installation
  query; the github-checks suite covers the pure `statusToConclusion` /
  `buildCheckRunOutput` helpers (the DB path is integration-only by existing
  convention).
- Manual data-flow re-read of `setup.ts`, `github-checks.ts`,
  `github-app.ts` (`fetchInstallationAccountLogin` / `mintInstallationToken`),
  and `schemas.ts` confirmed the tainted-input path and the fix's coverage.

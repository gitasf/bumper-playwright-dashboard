# Contributing to Wrightful

Thanks for your interest in contributing! This is a pnpm monorepo with two
shipping pieces — the dashboard (`apps/dashboard`) and the Playwright reporter
(`packages/reporter`) — plus an E2E suite (`packages/e2e`).

## Prerequisites

- **Node** (see `.nvmrc` / `package.json#engines` if present) and **pnpm**.
- The toolchain is [Vite+](https://viteplus.dev) (`vp`) — format, lint, and
  type-aware type-checking in one pass. It's installed as a dependency; no global
  setup needed.

## Getting started

```bash
pnpm install                 # install the workspace
pnpm setup:local             # .env.local + a demo team/project/API key (local dashboard)
pnpm dev                     # run the dashboard locally
```

## The dev loop

```bash
pnpm check                   # format + lint + type-check (vp check) — the gate
pnpm check:fix               # auto-fix format + lint

pnpm test                    # dashboard + reporter unit tests
pnpm --filter @wrightful/dashboard test    # dashboard only (node + workers lanes)
pnpm --filter @wrightful/reporter test     # reporter only
pnpm test:e2e                # Playwright E2E

# Single file:
pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/<file>.test.ts
```

Before opening a PR, make sure `pnpm check` and the relevant test suites pass. A
pre-commit hook (installed by the `prepare` script) auto-formats + lints staged
files.

## Database changes

The Postgres schema lives in `apps/dashboard/db/schema.ts` (the single source of
truth). After editing it, **regenerate the migration** — don't hand-edit the
generated SQL:

```bash
pnpm --filter @wrightful/dashboard db:generate
```

(The one sanctioned exception is DDL drizzle-kit can't emit, e.g.
`CREATE EXTENSION` — add it to the generated file with a comment saying why.)
Migrations apply automatically on `void deploy`. There's a fast pglite test lane
and a real-Postgres lane (`PG_TEST_URL`); if your change could hit a
node-postgres result-shape trap (int8-as-string) or transaction semantics, add a
case to the domain-appropriate file under `src/__tests__/pg-integration/`
(shared boot logic lives in `pg-integration/harness.ts`).

## Worklogs (required for non-trivial changes)

We track _what changed, why, and what was verified_ in `docs/worklog/` — these
are the project's decision history beyond `git log`. For any feature or
significant fix, add an entry `docs/worklog/YYYY-MM-DD-short-description.md`
(title, what changed, details, verification). See existing entries for the level
of detail. Architectural decisions also get an ADR under `docs/adr/`.

## Style & conventions

- Match the surrounding code — comment density, naming, idioms.
- Frontend: reuse the `apps/dashboard/src/components/ui/` wrappers over Base UI;
  don't import `@base-ui-components/react` from page code. Tailwind v4 tokens live
  in `src/styles.css`.
- Formatter: double quotes, semicolons, trailing commas (enforced by `vp check`).
- More architecture context: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md),
  [`CLAUDE.md`](./CLAUDE.md), and the worklogs.

## Pull requests

- Keep PRs focused; describe what changed and how you verified it.
- Reference any related issue.
- The reporter is versioned with [Changesets](https://github.com/changesets/changesets):
  run `pnpm changeset` for user-facing reporter changes.

## Reporting bugs & security issues

- Bugs / feature requests: open a [GitHub issue](https://github.com/joefairburn/wrightful/issues).
- Security vulnerabilities: **do not** open a public issue — see
  [`SECURITY.md`](./SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

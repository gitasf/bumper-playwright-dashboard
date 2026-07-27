#!/usr/bin/env node
// TEMPORARY — DELETE THIS FILE once it has run successfully against production.
// It repairs rows written before the reporter fix, and its own WHERE clause
// matches nothing afterwards. It is committed rather than run from a scratch
// directory so the change to production data is reviewable; that reason expires
// the moment the repair is done.
//
// GitHub's "Update branch" button pushes a `Merge <sha> into <sha>` commit onto
// a PR head. That commit IS the PR head, so the reporter's highest-fidelity
// source — the head commit's own `git log` message — captured it, and affected
// runs landed on the dashboard titled with two 40-character object names.
// `packages/reporter/src/ci.ts` now prefers the PR title at capture time; this
// recovers the real PR title from the GitHub API for the rows written before it.
//
// Not a Drizzle migration: resolving a title needs a network call per PR, and
// committed migrations run on every environment.
//
// Run directly (no package.json script — this is a repair, not a workflow), from
// apps/dashboard:
//   node scripts/backfill-run-titles.mjs               # dry run — prints a plan
//   node scripts/backfill-run-titles.mjs --apply       # writes
//   node scripts/backfill-run-titles.mjs --repo o/r    # limit to one repo
//
// Env:
//   DATABASE_URL   target Postgres (falls back to .env.local, like migrate-remote)
//   GITHUB_TOKEN   a token with `pull_requests: read` on the repos involved
//                  (WRIGHTFUL_GITHUB_TOKEN also accepted)
//
// Idempotent: the WHERE clause only matches generated messages, so a second run
// after a successful apply matches nothing.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnvDatabaseUrl, stripSystemRootCert } from "./lib/pg-url.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// POSIX twin of GENERATED_MERGE_MESSAGE in src/lib/text.ts. Postgres regex is not
// newline-sensitive by default, so `$` matches end-of-string only — a merge
// carrying a hand-written body is excluded here exactly as it is there. Kept
// character-identical to the JS `source` (minus its capture parens), which
// `src/__tests__/commit-title.test.ts` asserts by reading this file.
const GENERATED_MERGE_SQL = "^Merge [0-9a-f]{7,64} into [0-9a-f]{7,64}$";

// `btrim` before matching, because `commitMessage` is stored untrimmed — the
// dashboard's `commitTitle` trims for the same reason. Without it a
// whitespace-padded row would be invisible to both queries below, including the
// "not resolvable here" count.
//
// Binds the pattern as `$1`, so every query interpolating this passes
// GENERATED_MERGE_SQL first.
const GENERATED_MERGE_PREDICATE = `btrim("commitMessage") ~* $1`;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const repoFilter = (() => {
  const i = args.indexOf("--repo");
  if (i === -1) return undefined;
  const value = args[i + 1];
  // A bare or typo'd `--repo` must not silently widen to every repo.
  if (!value || value.startsWith("--")) {
    console.error(
      "backfill-run-titles: --repo needs a value, e.g. --repo o/r.",
    );
    process.exit(1);
  }
  return value;
})();

function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return stripSystemRootCert(fromEnv);
  const envLocal = `${root}/.env.local`;
  const fromFile = existsSync(envLocal)
    ? parseEnvDatabaseUrl(readFileSync(envLocal, "utf8"))
    : undefined;
  return fromFile ? stripSystemRootCert(fromFile) : undefined;
}

async function fetchPrTitle(repo, prNumber, token) {
  const response = await globalThis.fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "wrightful-backfill-run-titles",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  const body = await response.json();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  return title ? { title } : { error: "empty PR title" };
}

const connectionString = resolveDatabaseUrl();
if (!connectionString) {
  console.error(
    "backfill-run-titles: no DATABASE_URL in the environment or .env.local.",
  );
  process.exit(1);
}
const token = process.env.GITHUB_TOKEN ?? process.env.WRIGHTFUL_GITHUB_TOKEN;
if (!token) {
  console.error(
    "backfill-run-titles: set GITHUB_TOKEN (needs `pull_requests: read` on the affected repos).",
  );
  process.exit(1);
}

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString });
await client.connect();

try {
  const { rows } = await client.query(
    `SELECT id, repo, "prNumber"
       FROM runs
      WHERE ${GENERATED_MERGE_PREDICATE}
        AND repo IS NOT NULL
        AND "prNumber" IS NOT NULL
        AND ($2::text IS NULL OR repo = $2)
      ORDER BY repo, "prNumber"`,
    [GENERATED_MERGE_SQL, repoFilter ?? null],
  );

  // Runs are heavily clustered per PR (every CI re-run on the same head shares
  // one), so resolve each (repo, prNumber) once and fan the title back out.
  const byPr = new Map();
  for (const row of rows) {
    const key = `${row.repo}#${row.prNumber}`;
    const existing = byPr.get(key);
    if (existing) existing.runIds.push(row.id);
    else
      byPr.set(key, {
        repo: row.repo,
        prNumber: row.prNumber,
        runIds: [row.id],
      });
  }

  // Rows the query can't help: no repo/PR recorded, so there's nothing to
  // resolve a title from. Counted so the summary never implies full coverage.
  const { rows: unresolvable } = await client.query(
    `SELECT count(*)::int AS count
       FROM runs
      WHERE ${GENERATED_MERGE_PREDICATE}
        AND (repo IS NULL OR "prNumber" IS NULL)`,
    [GENERATED_MERGE_SQL],
  );

  console.log(
    `${rows.length} run(s) across ${byPr.size} PR(s) carry a generated merge title.`,
  );
  if (unresolvable[0].count > 0) {
    console.log(
      `${unresolvable[0].count} more have no repo/PR recorded — not resolvable here; ` +
        `the dashboard renders those abbreviated instead.`,
    );
  }
  if (byPr.size === 0) {
    console.log("Nothing to do.");
  }

  let updated = 0;
  let failed = 0;
  for (const { repo, prNumber, runIds } of byPr.values()) {
    const result = await fetchPrTitle(repo, prNumber, token);
    if (result.error) {
      failed += 1;
      console.warn(
        `  ✗ ${repo}#${prNumber} (${runIds.length} run(s)): ${result.error}`,
      );
      continue;
    }
    console.log(
      `  ${apply ? "→" : "·"} ${repo}#${prNumber} (${runIds.length} run(s)): ${result.title}`,
    );
    if (!apply) continue;
    // Re-assert the generated-message predicate in the UPDATE: a concurrent
    // write (or an earlier partial run) must not be clobbered by a title
    // resolved for the row's older state.
    const { rowCount } = await client.query(
      `UPDATE runs
          SET "commitMessage" = $2
        WHERE id = ANY($3::text[])
          AND ${GENERATED_MERGE_PREDICATE}`,
      [GENERATED_MERGE_SQL, result.title, runIds],
    );
    updated += rowCount;
  }

  console.log(
    apply
      ? `\nUpdated ${updated} run(s); ${failed} PR(s) could not be resolved.`
      : `\nDry run — no writes. ${failed} PR(s) could not be resolved. Re-run with --apply to write.`,
  );
} finally {
  await client.end();
}

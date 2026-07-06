# 2026-07-03 — Retention drain: fair project rotation + idle projects don't burn the budget (P1-4)

## What changed

The retention sweep could permanently starve the tail of the project list. Two
compounding causes, both fixed:

1. **`sweepRetention` selected projects with no `ORDER BY`** — Postgres returned
   them in a stable physical order, so the budget-bounded drain always started at
   the same head. Beyond the chunk budget, the same tail of projects was swept
   late or **never**, every 6-hour pass — an unbounded-retention violation for
   those tenants. Now the project scan is `ORDER BY random()`, so every project
   gets a fair chance across passes.

2. **`drainRetention` charged the chunk budget for every visited project**,
   including idle ones (nothing eligible). So even a mostly-idle deployment with
   more projects than the chunk ceiling (default 120) exhausted the budget on
   idle head probes. Now `recordChunk()` is charged **only for a productive
   chunk** (one that deleted rows); an idle project costs only its two probe
   SELECTs, bounded by the wall-clock deadline. The productive budget is therefore
   reserved for projects that actually have eligible rows.

Together: idle projects are effectively free and the busy set rotates randomly,
so the tail is reached.

## Why

From the 2026-07-03 architecture review (P1-4, hand-verified). This is the lighter
of the reviewer's two options (random rotation + productive-only charge) — it
removes the _deterministic_ starvation and the idle-budget waste without a new
cursor table/migration. A future upgrade to a persisted deterministic
round-robin cursor is possible if guaranteed (not just probabilistic) fairness is
ever required.

## Details

| File                                      | Change                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/retention.ts`                    | `sweepRetention` adds `.orderBy(sql\`random()\`)`(imported`sql`); `drainRetention`moves`budget.recordChunk()`+`progressed = true`inside the productive-chunk branch; updated the`SweepBudget.recordChunk`/`drainRetention`/`sweepRetention` docs. |
| `env.ts`                                  | `WRIGHTFUL_RETENTION_SWEEP_MAX_CHUNKS` doc now says it bounds PRODUCTIVE chunks (idle probes don't count).                                                                                                                                        |
| `src/__tests__/retention.workers.test.ts` | Added: 200 idle projects with `budget(5)` still visit ALL 200 (idle doesn't consume the budget); a productive head reaches the idle tail in round 1 before the budget is spent.                                                                   |

Termination is still guaranteed: the wall-clock deadline (`_BUDGET_MS`) is checked
before every project and remains the hard bound on an all-idle-but-slow scan; the
`progressed` no-progress round-exit is unchanged.

## Verification

- `pnpm --filter @wrightful/dashboard test:workers src/__tests__/retention.workers.test.ts` — 16 passed (2 new).
- `pnpm check` — 0 errors. The DB-touching `sweepRetention` (with `random()`) is exercised by the e2e dogfood suite per the standing real-DB-harness gap.

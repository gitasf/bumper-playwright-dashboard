---
"@wrightful/reporter": minor
---

Let a CI matrix that shards a suite without `--shard` declare its coordinates
through `WRIGHTFUL_SHARD_INDEX` (1-based) and `WRIGHTFUL_SHARD_TOTAL`.

Playwright populates `config.shard` only under `--shard`, so a matrix that
slices the suite by `--project`, spec path, or grep looked like a plain single
run even when every leg shared one `WRIGHTFUL_IDEMPOTENCY_KEY` — and the
dashboard finalized the shared run on the first leg's `/complete`, minutes
before the slower legs stopped streaming into it. Declaring the coordinates puts
those legs on the same path as native shards: the run stays `running` until every
leg reports, its status merges to the worst leg's, `expectedTotalTests` sums
across legs, each test row records its leg, and a late-starting leg is no longer
rejected with `409 ... already belongs to a completed execution`.

Both variables are required together with `1 <= index <= total`; a partial or
malformed declaration warns and falls back to the previous single-run shape.
`--shard` continues to win when Playwright is doing the slicing.

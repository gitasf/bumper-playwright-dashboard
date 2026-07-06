// History-seeding ingest loop. Pure orchestration over an injected ingest
// client: given the synthetic runs from generator.mjs and a client exposing
// `openRun / appendResults / completeRun`, it drives the open → chunked
// append → complete pipeline for each run and tallies the outcome.
//
// The client is the reporter's `StreamClient` (re-exported from
// `@wrightful/reporter`). Routing the seeder through it single-sources the
// protocol version, header assembly, and retry/Retry-After/timeout behaviour
// behind the one tested ingest client, instead of the seeder hand-rolling a
// second, weaker copy.
//
// Kept side-effect-free (no `fetch`, no `process`, no spinner) so this loop is
// unit-testable against a fake client — see
// src/__tests__/seed-ingest-runs.test.ts.

/**
 * The ingest surface this loop drives. The reporter's `StreamClient` satisfies
 * it; tests pass a recording fake.
 *
 * @typedef {{
 *   openRun: (payload: unknown) => Promise<{ runId: string }>,
 *   appendResults: (runId: string, results: unknown[]) => Promise<unknown>,
 *   completeRun: (
 *     runId: string,
 *     status: string,
 *     durationMs: number,
 *     options?: { completedAt?: number, shard?: { index: number, total: number } },
 *   ) => Promise<void>,
 * }} IngestClient
 */

/**
 * The seed runs produced by generator.mjs's `buildRun`.
 *
 * @typedef {{
 *   openPayload: unknown,
 *   resultsPayload: { results: unknown[] },
 *   completePayload: { status: string, durationMs: number, completedAt?: number },
 * }} SeedRun
 */

/**
 * One sharded run produced by generator.mjs's `buildShardedRun`: N shards that
 * share one idempotencyKey and each carry `shard {index,total}` on open+complete.
 *
 * @typedef {{
 *   perShard: Array<{
 *     shard: { index: number, total: number },
 *     openPayload: unknown,
 *     resultsPayload: { results: unknown[] },
 *     completePayload: { status: string, durationMs: number, shard: { index: number, total: number } },
 *   }>,
 * }} ShardedSeedRun
 */

/** Per-batch append size. D1 batches statements ≤99 params; 50 stays clear. */
export const DEFAULT_BATCH_SIZE = 50;

/**
 * Split `items` into contiguous chunks of at most `size`. Pure.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  }
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Drive a single run through the ingest client: open, append results in
 * batches of `batchSize`, then complete. Mirrors the reporter's per-run flow
 * minus artifacts (the seeder has none). The synthetic run carries a backdated
 * `completedAt` (months in the past) which is forwarded so the seeded history
 * lands at its historical time rather than collapsing to "now". Throws if any
 * client call rejects — the client owns retry/backoff internally; an exhausted
 * retry surfaces here.
 *
 * @param {IngestClient} client
 * @param {SeedRun} run
 * @param {{ batchSize?: number }} [options]
 * @returns {Promise<string>} the opened run id
 */
export async function ingestRun(client, run, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const { runId } = await client.openRun(run.openPayload);
  for (const batch of chunk(run.resultsPayload.results, batchSize)) {
    await client.appendResults(runId, batch);
  }
  await client.completeRun(
    runId,
    run.completePayload.status,
    run.completePayload.durationMs,
    { completedAt: run.completePayload.completedAt },
  );
  return runId;
}

/**
 * Drive ONE sharded run to completion: for each shard, open (every shard shares
 * the run's idempotencyKey, so the dashboard merges them into one run), append
 * that shard's results, then complete WITH the shard coordinates. Completing per
 * shard is what makes the dashboard record a `runShards` row and defer the run's
 * terminal status until every shard has reported — this drives the real sharded
 * ingest path, exactly as N CI shards hitting the API would.
 *
 * @param {IngestClient} client
 * @param {ShardedSeedRun} run
 * @param {{
 *   batchSize?: number,
 *   onShard?: (index: number, total: number) => void,
 * }} [options]
 * @returns {Promise<string>} the merged run id
 */
export async function ingestShardedRun(client, run, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let runId = "";
  for (const shard of run.perShard) {
    const opened = await client.openRun(shard.openPayload);
    runId = opened.runId;
    for (const batch of chunk(shard.resultsPayload.results, batchSize)) {
      await client.appendResults(runId, batch);
    }
    await client.completeRun(
      runId,
      shard.completePayload.status,
      shard.completePayload.durationMs,
      { shard: shard.completePayload.shard },
    );
    options.onShard?.(shard.shard.index, run.perShard.length);
  }
  return runId;
}

/**
 * Ingest every run, isolating per-run failures so one bad run can't abort the
 * whole seed (matching the previous loop's tally-and-continue behaviour). The
 * underlying client already retries transient 5xx/429 per call.
 *
 * @param {IngestClient} client
 * @param {SeedRun[]} runs
 * @param {{
 *   batchSize?: number,
 *   onError?: (error: unknown, index: number) => void,
 * }} [options]
 * @returns {Promise<{ completed: number, failed: number }>}
 */
export async function ingestRuns(client, runs, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let completed = 0;
  let failed = 0;
  for (let i = 0; i < runs.length; i++) {
    try {
      await ingestRun(client, runs[i], { batchSize });
      completed++;
    } catch (error) {
      failed++;
      options.onError?.(error, i);
    }
  }
  return { completed, failed };
}

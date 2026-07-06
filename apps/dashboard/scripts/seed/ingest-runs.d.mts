// Type surface for the JSDoc-typed `ingest-runs.mjs` seam. The `scripts/`
// tree is `.mjs` glue (outside the typechecked `src` program), so this
// hand-written declaration lets the `src/__tests__` test import the loop with
// real types instead of an implicit `any`.

/** Playwright shard coordinates carried on open + complete. */
export interface ShardCoords {
  index: number;
  total: number;
}

/** The ingest surface this loop drives; the reporter's StreamClient satisfies it. */
export interface IngestClient {
  openRun(payload: unknown): Promise<{ runId: string }>;
  appendResults(runId: string, results: unknown[]): Promise<unknown>;
  completeRun(
    runId: string,
    status: string,
    durationMs: number,
    options?: { completedAt?: number; shard?: ShardCoords },
  ): Promise<void>;
}

/** A synthetic run as produced by generator.mjs's `buildRun`. */
export interface SeedRun {
  openPayload: unknown;
  resultsPayload: { results: unknown[] };
  completePayload: { status: string; durationMs: number; completedAt?: number };
}

/** One sharded run as produced by generator.mjs's `buildShardedRun`. */
export interface ShardedSeedRun {
  perShard: Array<{
    shard: ShardCoords;
    openPayload: unknown;
    resultsPayload: { results: unknown[] };
    completePayload: { status: string; durationMs: number; shard: ShardCoords };
  }>;
}

export const DEFAULT_BATCH_SIZE: number;

export function chunk<T>(items: T[], size: number): T[][];

export function ingestRun(
  client: IngestClient,
  run: SeedRun,
  options?: { batchSize?: number },
): Promise<string>;

export function ingestRuns(
  client: IngestClient,
  runs: SeedRun[],
  options?: {
    batchSize?: number;
    onError?: (error: unknown, index: number) => void;
  },
): Promise<{ completed: number; failed: number }>;

export function ingestShardedRun(
  client: IngestClient,
  run: ShardedSeedRun,
  options?: {
    batchSize?: number;
    onShard?: (index: number, total: number) => void;
  },
): Promise<string>;

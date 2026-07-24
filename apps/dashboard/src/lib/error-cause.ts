/**
 * Flatten an error — and its `cause` chain — into a loggable, JSON-safe object.
 *
 * Drizzle wraps the underlying driver error: a `DrizzleQueryError`'s own
 * `.message` is only `"Failed query: <sql>"`, and the REAL Postgres error
 * (`FATAL: branch … does not exist`, `relation "x" does not exist`, a
 * constraint violation, a dropped connection) lives on `.cause`. Logging
 * `err.message` / `err.stack` alone therefore hides the actual reason — every
 * DB failure looks identical in Cloudflare Tail. This walks `.cause` and lifts
 * node-postgres' diagnostic fields so the cause is visible on line one.
 *
 * Pure + side-effect free (no logger import) so it stays unit-testable and can
 * be spread into any `logger.*({ ...describeError(err) })` call.
 */

// node-postgres attaches these to its error objects (the `cause` of a Drizzle
// query error). `code` is the SQLSTATE (e.g. `28000`, `42P01`); the rest are
// the server's diagnostic fields.
const PG_FIELDS = [
  "code",
  "detail",
  "severity",
  "hint",
  "constraint",
  "table",
  "schema",
  "column",
  "routine",
] as const;

function pgFields(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PG_FIELDS) if (e[k] != null) out[k] = e[k];
  return out;
}

// Recursion bound for `.cause` chains. A 1-cycle (`e.cause === e`) is caught
// by `seen` below, but some retry/pool wrappers produce a 2+ cycle
// (`a.cause = b; b.cause = a`) or a pathologically deep chain — either would
// blow the stack inside `describeError` itself, the last line of defense in
// the error → page mapper and cron `loggedScheduled`. Cap depth AND track
// already-seen errors so serialization always terminates.
export const MAX_CAUSE_DEPTH = 8;

function serialize(
  err: unknown,
  withStack: boolean,
  depth = 0,
  seen: Set<unknown> = new Set(),
): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const e = err as Error & Record<string, unknown>;
  const out: Record<string, unknown> = { message: e.message, ...pgFields(e) };
  if (withStack && e.stack) out.stack = e.stack;
  seen.add(err);
  const cause = (e as { cause?: unknown }).cause;
  // Recurse into the cause (the real driver error) — without its stack, to
  // keep the log entry readable — up to MAX_CAUSE_DEPTH levels and never back
  // into an already-seen error.
  if (cause != null && !seen.has(cause) && depth < MAX_CAUSE_DEPTH) {
    out.cause = serialize(cause, false, depth + 1, seen);
  }
  return out;
}

export function describeError(err: unknown): Record<string, unknown> {
  return serialize(err, true);
}

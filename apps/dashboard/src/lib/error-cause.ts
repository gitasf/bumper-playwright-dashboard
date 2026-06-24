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

function serialize(err: unknown, withStack: boolean): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const e = err as Error & Record<string, unknown>;
  const out: Record<string, unknown> = { message: e.message, ...pgFields(e) };
  if (withStack && e.stack) out.stack = e.stack;
  const cause = (e as { cause?: unknown }).cause;
  // Recurse one level into the cause (the real driver error) — without its
  // stack, to keep the log entry readable.
  if (cause != null && cause !== err) out.cause = serialize(cause, false);
  return out;
}

export function describeError(err: unknown): Record<string, unknown> {
  return serialize(err, true);
}

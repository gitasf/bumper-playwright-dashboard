import { logger } from "void/log";
import { isUniqueViolation } from "@/lib/db/batch";
import { describeError } from "@/lib/error-cause";

/**
 * Log an unexpected mutation failure to Cloudflare Tail, cause-aware. Drizzle
 * wraps the driver error — `DrizzleQueryError.message` is just
 * `"Failed query: <sql>"`, the real pg reason (SQLSTATE, `relation does not
 * exist`) on `.cause` — so it goes through `describeError`, which walks the
 * cause chain and lifts the pg diagnostics into the payload. `extra` carries
 * call-site context (teamId/projectId).
 *
 * The one logging path for a mutation DB error: `mutationErrorMessage`'s
 * non-unique branch and the settings actions' own catch blocks (retention,
 * codeowners, delete team/project) that map failures to a flash themselves.
 */
export function logMutationFailure(
  context: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  logger.error(context, { ...extra, ...describeError(err) });
}

/**
 * Map a thrown mutation error to a user-facing flash message.
 *
 * A UNIQUE-constraint violation is an *expected* user error (duplicate
 * slug/name) — return the supplied friendly message WITHOUT logging.
 * Anything else is *unexpected* (DB unavailable, batch failure, a bug) — log
 * it to Cloudflare Tail via `logMutationFailure` (cause-aware, so the pg
 * SQLSTATE survives Drizzle's wrapping) before returning a generic message,
 * so production mutation failures are never silently swallowed.
 *
 * Replaces the copy-pasted `msg.includes("UNIQUE") ? … : …` blocks in the
 * settings create/update actions, which discarded the original error. The
 * violation detection delegates to `isUniqueViolation` — the single home for
 * the unique-violation error shape, shared with the ingest race-recovery paths.
 */
export function mutationErrorMessage(
  err: unknown,
  opts: { context: string; uniqueMessage: string; genericMessage: string },
): string {
  if (isUniqueViolation(err)) return opts.uniqueMessage;
  logMutationFailure(opts.context, err);
  return opts.genericMessage;
}

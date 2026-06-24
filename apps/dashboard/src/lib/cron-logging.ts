import { defineScheduled } from "void";
import { logger } from "void/log";
import { describeError } from "@/lib/error-cause";

/**
 * Wrap a scheduled (cron) handler so a thrown error is logged WITH its full
 * cause chain before it propagates.
 *
 * Cron exceptions bubble uncaught to workerd, which records only the top-level
 * message — for a Drizzle failure that's the opaque `"Failed query: …"`
 * wrapper, hiding the real Postgres error (a stale-credential `FATAL`, a
 * missing relation, a constraint violation). Routing through `describeError`
 * (which lifts `error.cause` + node-postgres' diagnostic fields) makes the
 * actual reason visible in Cloudflare Tail / `void project logs`.
 *
 * We re-throw after logging so the tick still registers as a failed scheduled
 * event (`outcome: "exception"`) — observability and alerting are unchanged;
 * only the detail improves.
 */
export function loggedScheduled(
  name: string,
  run: () => Promise<void>,
): ReturnType<typeof defineScheduled> {
  return defineScheduled(async () => {
    try {
      await run();
    } catch (err) {
      logger.error(`cron failed: ${name}`, {
        cron: name,
        ...describeError(err),
      });
      throw err;
    }
  });
}

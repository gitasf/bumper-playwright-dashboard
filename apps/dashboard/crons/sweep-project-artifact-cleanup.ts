import { logger } from "void/log";
import { loggedScheduled } from "@/lib/cron-logging";
import { sweepProjectArtifactCleanup } from "@/lib/project-artifact-cleanup";

/**
 * Retry durable R2 prefix cleanup jobs left by project/team deletion.
 *
 * Offset from every other five-minute cron because Void dispatches scheduled
 * handlers by cron expression and duplicate expressions shadow one another.
 */
export const cron = "1-59/5 * * * *";

export default loggedScheduled("sweep-project-artifact-cleanup", async () => {
  const result = await sweepProjectArtifactCleanup();
  if (result.claimed > 0) {
    logger.info("project artifact cleanup sweep", { ...result });
  }
});

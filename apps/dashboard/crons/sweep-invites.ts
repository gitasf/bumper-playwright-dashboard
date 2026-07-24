import { loggedScheduled } from "@/lib/cron-logging";
import { logger } from "void/log";
import {
  EXPIRED_INVITE_SWEEP_BATCH_SIZE,
  sweepExpiredInvites,
} from "@/lib/invites";

/** Daily garbage collection for expired team invites. */
export const cron = "15 4 * * *";

// Bound each invocation while allowing ordinary backlogs to drain in one tick.
const MAX_CHUNKS = 20;

export default loggedScheduled("sweep-invites", async () => {
  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const n = await sweepExpiredInvites(now);
    deleted += n;
    if (n < EXPIRED_INVITE_SWEEP_BATCH_SIZE) break;
  }

  if (deleted > 0) {
    logger.info("swept expired invites", { deleted });
  }
});

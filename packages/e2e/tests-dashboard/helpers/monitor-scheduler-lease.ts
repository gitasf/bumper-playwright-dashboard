import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import lockfile from "proper-lockfile";

const LOCK_TARGET = fileURLToPath(
  new URL("../.auth/monitor-scheduler", import.meta.url),
);

/**
 * A contended scheduler test may spend 60s waiting for the lease, another 45s
 * polling the execution, and additional time resuming/pausing through the UI.
 * Keep consuming specs above that complete worst-case envelope.
 */
export const MONITOR_SCHEDULER_TEST_TIMEOUT_MS = 180_000;

/**
 * Cross-worker lease for tests that advance the dashboard's global monitor
 * scheduler. Playwright workers are separate Node processes, so this uses
 * proper-lockfile's atomic mkdir lease, periodic mtime heartbeat, stale-owner
 * detection, and ownership-checked release. The previous hand-rolled
 * compare/rename reclamation could let a stale reclaimer interfere with a
 * newly acquired lease.
 */
export async function acquireMonitorSchedulerLease(): Promise<
  () => Promise<void>
> {
  await mkdir(dirname(LOCK_TARGET), { recursive: true });
  await writeFile(LOCK_TARGET, "", { flag: "a" });
  return lockfile.lock(LOCK_TARGET, {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: {
      retries: 120,
      factor: 1,
      minTimeout: 500,
      maxTimeout: 500,
      randomize: true,
    },
  });
}

import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearMonitorSchedulerLease } from "./helpers/monitor-scheduler-lease";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, ".auth", "fixture.json");
const STORAGE_STATE_PATH = resolve(__dirname, ".auth", "storageState.json");

export default async function globalTeardown(): Promise<void> {
  await globalThis.__wrightfulDashboardFixture?.teardown();
  globalThis.__wrightfulDashboardFixture = undefined;
  for (const path of [FIXTURE_PATH, STORAGE_STATE_PATH]) {
    if (existsSync(path)) unlinkSync(path);
  }
  await clearMonitorSchedulerLease();
}

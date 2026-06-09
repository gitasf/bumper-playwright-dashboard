import { SandboxExecutor } from "@/lib/monitors/sandbox-executor";
import { StubExecutor } from "@/lib/monitors/stub-executor";
import type { MonitorExecutor } from "@/lib/monitors/types";

/**
 * Resolve the `WRIGHTFUL_MONITOR_EXECUTOR` env value to a `MonitorExecutor`.
 *
 * `"stub"` selects the in-process synthesizer (unit tests + any env that wants
 * to exercise the schedule→queue→ingest pipeline without a container).
 *
 * Anything else (default `"sandbox"`) selects the production `SandboxExecutor`,
 * which runs the user's Playwright in a Void Sandbox container. NOTE: importing
 * it pulls in `void/sandbox`, which makes Void infer the SANDBOX binding and
 * build the sandbox image on every local `vp dev` — i.e. **Docker is required to
 * run `pnpm dev`** (the image builds once, then caches). The image is the slim
 * Chromium-only `apps/dashboard/Dockerfile.sandbox`, wired via `void.json#sandbox`.
 * See `docs/worklog/2026-06-07-synthetic-monitoring.md` for the local-dev +
 * deploy steps. This is the ONLY module that imports the concrete executors, so
 * it is imported only by the queue consumer — never by the pure `executor.ts`
 * orchestrator or any unit test (keeping those free of the runtime imports the
 * vitest harness can't resolve).
 */
export function resolveExecutor(name: string): MonitorExecutor {
  return name === "stub" ? new StubExecutor() : new SandboxExecutor();
}

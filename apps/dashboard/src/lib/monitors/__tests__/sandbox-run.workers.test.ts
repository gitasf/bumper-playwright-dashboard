import { describe, expect, it, vi } from "vite-plus/test";
import {
  runSandboxExecution,
  type SandboxHandle,
  type SandboxRunDeps,
} from "@/lib/monitors/sandbox-run";
import type { Monitor, MonitorExecution } from "@/lib/monitors/types";
import type { TenantScope } from "@/lib/scope";

/**
 * `runSandboxExecution` is the pure, dependency-injected container lifecycle of
 * a synthetic-monitor check (the cost-critical half of the prod
 * `SandboxExecutor`). These tests pin the ONE invariant that bounds Cloudflare
 * container spend: a started container is ALWAYS torn down — `destroy()` is
 * called on every exit path (pass, app-fail, wall-clock timeout, mid-run
 * throw), is NOT called when no container was ever started (getSandbox threw,
 * empty source, scope/mint failure), and a failing teardown never flips the
 * recorded result. They also pin that the plan-resolved `sleepAfter` reaches
 * `getSandbox` (the leaked-container idle backstop) and that the key is always
 * revoked.
 *
 * The matching ack/retry decision (what the queue does with each
 * `infraError`) is tested separately in `executor.test.ts`.
 */

const MONITOR = {
  id: "mon-1",
  teamId: "team-1",
  projectId: "proj-1",
  source:
    "import { test } from '@playwright/test'; test('up', async () => {});",
} as Monitor;

const EXECUTION = {
  id: "ex-1",
  projectId: "proj-1",
  createdAt: 1,
} as MonitorExecution;

const SCOPE = {
  teamId: "team-1",
  projectId: "proj-1",
  teamSlug: "team",
  projectSlug: "proj",
} as unknown as TenantScope;

const MAX_DURATION_MS = 300_000;

/** A sandbox stub whose four driven methods are spies. */
function makeSandbox(
  overrides: Partial<
    Record<keyof SandboxHandle, SandboxHandle[keyof SandboxHandle]>
  > = {},
): {
  mkdir: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    mkdir: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn(() => Promise.resolve()),
    exec: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => Promise.resolve()),
    ...(overrides as object),
  };
}

/**
 * Build `SandboxRunDeps` with passing fakes, returning the sandbox spy and the
 * `getSandbox` spy so a test can assert teardown + acquire options. `now` is a
 * fixed clock by default; the timeout test overrides it.
 */
function makeDeps(overrides: Partial<SandboxRunDeps> = {}): {
  deps: SandboxRunDeps;
  sandbox: ReturnType<typeof makeSandbox>;
  getSandbox: ReturnType<typeof vi.fn>;
  revokeSyntheticKey: ReturnType<typeof vi.fn>;
} {
  const sandbox = makeSandbox();
  const getSandbox =
    (overrides.getSandbox as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(() => Promise.resolve(sandbox as unknown as SandboxHandle));
  const revokeSyntheticKey =
    (overrides.revokeSyntheticKey as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(() => Promise.resolve());
  const deps: SandboxRunDeps = {
    getSandbox: getSandbox as SandboxRunDeps["getSandbox"],
    mintSyntheticKey: vi.fn(() =>
      Promise.resolve({ id: "key-1", token: "wrf_secret" }),
    ),
    revokeSyntheticKey:
      revokeSyntheticKey as SandboxRunDeps["revokeSyntheticKey"],
    tenantScopeForMonitor: vi.fn(() => Promise.resolve(SCOPE)),
    findRunByIdempotencyKey: vi.fn(() =>
      Promise.resolve({ id: "run-1", status: "passed", durationMs: 1234 }),
    ),
    classifyLimitError: () => null,
    maxDurationMs: MAX_DURATION_MS,
    sleepAfter: "60s",
    publicUrl: "https://app.test",
    now: () => 1000,
    ...overrides,
  };
  return { deps, sandbox, getSandbox, revokeSyntheticKey };
}

describe("runSandboxExecution — container teardown", () => {
  it("destroys the container and revokes the key on a passing run", async () => {
    const { deps, sandbox, revokeSyntheticKey } = makeDeps();

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ state: "pass", infraError: false });
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(revokeSyntheticKey).toHaveBeenCalledWith("key-1", 1);
  });

  it("destroys the container on a real (failing) app outcome", async () => {
    const { deps, sandbox } = makeDeps({
      findRunByIdempotencyKey: vi.fn(() =>
        Promise.resolve({ id: "run-2", status: "failed", durationMs: 50 }),
      ),
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ state: "fail", infraError: false });
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the container when the exec hits the wall-clock budget", async () => {
    // Advance the clock by the full budget inside exec so the elapsed-time
    // classifier reads it as the timeout kill, and leave the run unsettled.
    let clock = 1000;
    const sandbox = makeSandbox({
      exec: vi.fn(() => {
        clock += MAX_DURATION_MS;
        return Promise.reject(new Error("killed: timeout"));
      }),
    });
    const { deps } = makeDeps({
      getSandbox: vi.fn(() =>
        Promise.resolve(sandbox as unknown as SandboxHandle),
      ),
      findRunByIdempotencyKey: vi.fn(() => Promise.resolve(null)),
      now: () => clock,
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    // Terminal user outcome (never retried) — and the container is still torn down.
    expect(result.state).toBe("error");
    expect(result.infraError).toBe(false);
    expect(result.errorMessage).toContain("execution budget");
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the container when a step throws a real (early) transport error", async () => {
    const sandbox = makeSandbox({
      exec: vi.fn(() =>
        Promise.reject(new Error("websocket connection failed")),
      ),
    });
    const { deps } = makeDeps({
      getSandbox: vi.fn(() =>
        Promise.resolve(sandbox as unknown as SandboxHandle),
      ),
      now: () => 1000, // elapsed stays 0 < budget → rethrows as infra error
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ infraError: true });
    expect(result.errorMessage).toContain("websocket connection failed");
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });

  it("does NOT call destroy when getSandbox throws (no container was started)", async () => {
    const sandbox = makeSandbox();
    const { deps } = makeDeps({
      getSandbox: vi.fn(() => Promise.reject(new Error("limit"))),
      classifyLimitError: () => ({ reason: "concurrency" }),
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ infraError: true });
    expect(result.errorMessage).toContain("concurrency");
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it("a destroy() failure is swallowed and never flips the recorded result", async () => {
    const sandbox = makeSandbox({
      destroy: vi.fn(() => Promise.reject(new Error("teardown RPC failed"))),
    });
    const { deps } = makeDeps({
      getSandbox: vi.fn(() =>
        Promise.resolve(sandbox as unknown as SandboxHandle),
      ),
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    // The pass result stands even though teardown rejected.
    expect(result).toMatchObject({ state: "pass", infraError: false });
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("runSandboxExecution — never launches/leaks a container before acquire", () => {
  it("returns terminally without acquiring a container when the source is empty", async () => {
    const { deps, getSandbox } = makeDeps();

    const result = await runSandboxExecution(
      {
        monitor: { ...MONITOR, source: "   " } as Monitor,
        execution: EXECUTION,
      },
      deps,
    );

    expect(result).toMatchObject({ state: "error", infraError: false });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("returns an infra error without acquiring a container when scope resolution fails", async () => {
    const { deps, getSandbox, revokeSyntheticKey } = makeDeps({
      tenantScopeForMonitor: vi.fn(() =>
        Promise.reject(new Error("project gone")),
      ),
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ infraError: true });
    expect(getSandbox).not.toHaveBeenCalled();
    // No key was minted yet, so there is nothing to revoke.
    expect(revokeSyntheticKey).not.toHaveBeenCalled();
  });

  it("returns an infra error without acquiring a container when key minting fails", async () => {
    const { deps, getSandbox } = makeDeps({
      mintSyntheticKey: vi.fn(() => Promise.reject(new Error("db down"))),
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ infraError: true });
    expect(getSandbox).not.toHaveBeenCalled();
  });
});

describe("runSandboxExecution — leaked-container idle backstop", () => {
  it("passes the plan-resolved sleepAfter through to getSandbox", async () => {
    const { deps, getSandbox } = makeDeps({ sleepAfter: "90s" });

    await runSandboxExecution({ monitor: MONITOR, execution: EXECUTION }, deps);

    expect(getSandbox).toHaveBeenCalledWith("ex-1", { sleepAfter: "90s" });
  });

  it("treats a container that streamed no run as a retryable infra error (and still tears down)", async () => {
    const sandbox = makeSandbox();
    const { deps } = makeDeps({
      getSandbox: vi.fn(() =>
        Promise.resolve(sandbox as unknown as SandboxHandle),
      ),
      findRunByIdempotencyKey: vi.fn(() => Promise.resolve(null)),
    });

    const result = await runSandboxExecution(
      { monitor: MONITOR, execution: EXECUTION },
      deps,
    );

    expect(result).toMatchObject({ infraError: true });
    expect(result.errorMessage).toContain("no run was streamed");
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });
});

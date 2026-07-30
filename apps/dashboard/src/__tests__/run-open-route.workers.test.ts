import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "hono";

const withValidator = vi.fn(
  () =>
    (
      handler: (
        c: Context,
        validated: { body: Record<string, unknown> },
      ) => Promise<Response>,
    ) =>
      handler,
);
vi.mock("void", () => ({
  defineHandler: { withValidator },
}));

vi.mock("@/lib/api-auth", () => ({ getApiKey: () => "api-key" }));
vi.mock("@/lib/scope", () => ({
  tenantScopeForApiKey: () =>
    Promise.resolve({
      teamId: "team",
      projectId: "project",
      teamSlug: "acme",
      projectSlug: "web",
    }),
}));

const checkQuota = vi.fn();
vi.mock("@/lib/usage", () => ({ checkQuota }));

const openRun = vi.fn();
class RunQuotaOvershootError extends Error {}
class RunRowCapExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly count: number,
  ) {
    super("row cap");
  }
}
vi.mock("@/lib/ingest", () => ({
  backdatingAllowed: () => false,
  openRun,
  RunQuotaOvershootError,
  RunRowCapExceededError,
}));

const { POST } = await import("../../routes/api/runs/index");
const invokePost = POST as unknown as (
  c: Context,
  validated: { body: Record<string, unknown> },
) => Promise<Response>;

function context() {
  const headers = new Headers();
  return {
    header: (name: string, value: string) => headers.set(name, value),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    _headers: headers,
  } as unknown as Context & { _headers: Headers };
}

const payload = {
  idempotencyKey: "execution",
  run: { plannedTests: [] },
};

beforeEach(() => {
  checkQuota.mockReset();
  openRun.mockReset();
  checkQuota.mockResolvedValue({
    status: "blocked",
    dimension: "runs",
    used: 10,
    limit: 10,
  });
});

describe("POST /api/runs quota ordering", () => {
  it("lets an idempotent late shard resolve when usage is already at the limit", async () => {
    openRun.mockResolvedValue({
      runId: "run-existing",
      duplicate: true,
    });

    const response = await invokePost(context(), { body: payload });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: "run-existing",
      runUrl: "/t/acme/p/web/runs/run-existing",
      duplicate: true,
    });
    expect(openRun).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team", projectId: "project" }),
      payload,
      expect.any(Number),
      { runsQuotaLimit: 10 },
    );
  });

  it("still rejects a fresh run through openRun's atomic guarded bump", async () => {
    openRun.mockRejectedValue(new RunQuotaOvershootError());

    const response = await invokePost(context(), { body: payload });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ limit: 10, used: 10 });
  });

  it("does not count an idempotent duplicate again in the soft-limit header", async () => {
    checkQuota.mockResolvedValue({
      status: "softWarn",
      dimension: "runs",
      used: 8,
      limit: 10,
    });
    openRun.mockResolvedValue({
      runId: "run-existing",
      duplicate: true,
    });
    const c = context();

    const response = await invokePost(c, { body: payload });

    expect(response.status).toBe(200);
    expect(c._headers.get("X-Wrightful-Quota-Warning")).toBe("runs 8/10");
  });
});

describe("POST /api/runs terminal-idempotency conflict", () => {
  // Reopening a key that already belongs to a completed execution is refused
  // rather than rearming the run. The 409 is the public contract the reporter
  // reads to tell "your CI re-run reused a key" apart from a transient failure.
  it("returns 409 with the runId when the key is already terminal", async () => {
    checkQuota.mockResolvedValue({
      status: "ok",
      dimension: "runs",
      used: 3,
      limit: 10,
    });
    openRun.mockResolvedValue({
      runId: "run-done",
      duplicate: true,
      terminalDuplicate: true,
    });

    const response = await invokePost(context(), { body: payload });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This idempotency key already belongs to a completed execution. Use a unique key for each CI run attempt.",
      runId: "run-done",
    });
  });

  it("takes precedence over the soft-limit warning header", async () => {
    // The conflict returns before the softWarn branch, so a terminal duplicate
    // that also trips the soft limit must NOT advertise quota headroom for a
    // request that opened nothing.
    checkQuota.mockResolvedValue({
      status: "softWarn",
      dimension: "runs",
      used: 8,
      limit: 10,
    });
    openRun.mockResolvedValue({
      runId: "run-done",
      duplicate: true,
      terminalDuplicate: true,
    });
    const c = context();

    const response = await invokePost(c, { body: payload });

    expect(response.status).toBe(409);
    expect(c._headers.get("X-Wrightful-Quota-Warning")).toBeNull();
  });
});

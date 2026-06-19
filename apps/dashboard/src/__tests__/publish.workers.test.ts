import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

/**
 * `postToRoom` (`@/realtime/publish`, via broadcastRunRoom/broadcastProjectRoom)
 * is the SINGLE server→room publish path and was previously untested — the two
 * ingest suites mock it wholesale. It is the only site of the internal secret
 * header and the non-fatal swallow that keeps a realtime hiccup from failing a
 * committed D1 write. We mock the Void runtime seams (binding resolution,
 * instance-id, logger, env) and assert the binding-name → instance-id → header →
 * POST contract + the warn/swallow error paths.
 */

const fetchSpy = vi.fn<(request: Request) => Promise<Response>>(() =>
  Promise.resolve(new Response(null, { status: 200 })),
);
const idFromNameSpy = vi.fn((name: string) => ({ __id: name }));
const getSpy = vi.fn((_id: unknown) => ({ fetch: fetchSpy }));
const requireRuntimeBindingSpy = vi.fn((_name: string) => ({
  idFromName: idFromNameSpy,
  get: getSpy,
}));
vi.mock("void/_env", () => ({
  requireRuntimeBinding: requireRuntimeBindingSpy,
}));

const buildIdSpy = vi.fn(
  (_route: { params: string[] }, params: Record<string, string>) =>
    `inst:${JSON.stringify(params)}`,
);
vi.mock("void/runtime/ws-server", () => ({
  buildWebSocketInstanceId: buildIdSpy,
}));

const warnSpy = vi.fn();
const errorSpy = vi.fn();
vi.mock("void/log", () => ({ logger: { warn: warnSpy, error: errorSpy } }));

// Dedicated internal secret set → resolveInternalSecret should prefer it.
vi.mock("void/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "auth-secret",
    REALTIME_INTERNAL_SECRET: "internal-secret",
  },
}));

const { broadcastRunRoom, broadcastProjectRoom } =
  await import("@/realtime/publish");
const { INTERNAL_HEADER } = await import("@/realtime/room-server");

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
  idFromNameSpy.mockClear();
  getSpy.mockClear();
  requireRuntimeBindingSpy.mockClear();
  buildIdSpy.mockClear();
  warnSpy.mockReset();
  errorSpy.mockReset();
});

describe("broadcastRunRoom", () => {
  it("resolves the run binding, routes by instance id, and POSTs the secret-headed event", async () => {
    const event = { type: "progress", changedTests: [], summary: { x: 1 } };
    await broadcastRunRoom("run-1", event as never);

    expect(requireRuntimeBindingSpy).toHaveBeenCalledWith("WsRunRunIdWs");
    expect(buildIdSpy).toHaveBeenCalledWith(
      { params: ["runId"] },
      {
        runId: "run-1",
      },
    );
    expect(idFromNameSpy).toHaveBeenCalledWith('inst:{"runId":"run-1"}');
    // get(id) is fed the idFromName result.
    expect(getSpy).toHaveBeenCalledWith({ __id: 'inst:{"runId":"run-1"}' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const req = fetchSpy.mock.calls[0]![0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://void.local/ws/run/run-1");
    // Prefers the dedicated REALTIME_INTERNAL_SECRET over BETTER_AUTH_SECRET.
    expect(req.headers.get(INTERNAL_HEADER)).toBe("internal-secret");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.text()).toBe(JSON.stringify(event));
  });
});

describe("broadcastProjectRoom", () => {
  it("resolves the project binding + path", async () => {
    const event = { type: "run-progress", runId: "run-1", summary: { x: 1 } };
    await broadcastProjectRoom("proj-1", event as never);

    expect(requireRuntimeBindingSpy).toHaveBeenCalledWith(
      "WsProjectProjectIdWs",
    );
    expect(buildIdSpy).toHaveBeenCalledWith(
      { params: ["projectId"] },
      {
        projectId: "proj-1",
      },
    );
    const req = fetchSpy.mock.calls[0]![0];
    expect(req.url).toBe("https://void.local/ws/project/proj-1");
    expect(req.headers.get(INTERNAL_HEADER)).toBe("internal-secret");
  });
});

describe("non-fatal error handling", () => {
  it("logs a warning (does not throw) when the room responds non-ok", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      broadcastRunRoom("run-1", { type: "progress" } as never),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("swallows + logs an error when the room fetch throws (D1 write already committed)", async () => {
    fetchSpy.mockRejectedValue(new Error("DO unreachable"));
    await expect(
      broadcastRunRoom("run-1", { type: "progress" } as never),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows + logs when the binding can't be resolved (stale binding name)", async () => {
    requireRuntimeBindingSpy.mockImplementationOnce(() => {
      throw new Error("no binding WsRunRunIdWs");
    });
    await expect(
      broadcastRunRoom("run-1", { type: "progress" } as never),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

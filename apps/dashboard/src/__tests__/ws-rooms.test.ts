import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

/**
 * The `void/ws` room handlers (`routes/ws/**.ws.ts`). `onRequest` is the SOLE
 * gate against a forged cross-tenant broadcast on the public room path; `onBefore
 * Connect` is the connect-time origin + tenant-isolation + capacity gate. Both were
 * untested (the ingest suites mock the publisher and never invoke the room
 * receiver). `defineRoom` is mocked as a passthrough so the default export is the
 * definition object whose hooks we invoke with a fabricated context.
 */

vi.mock("void/ws", () => ({
  defineRoom: (def: unknown) => def,
}));
vi.mock("void/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "auth-secret",
    REALTIME_INTERNAL_SECRET: "internal-secret",
    WRIGHTFUL_PUBLIC_URL: "https://dashboard.example",
  },
}));
const authorizeSpy =
  vi.fn<
    (
      userId: string | null,
      topic: string,
    ) => Promise<{ ok: boolean; status?: number }>
  >();
vi.mock("@/lib/authz", () => ({ authorizeTopicSubscription: authorizeSpy }));

const { INTERNAL_HEADER, ROOM_CONNECTION_CAP } =
  await import("@/realtime/room-server");

type RoomDef = {
  onBeforeConnect: (ctx: unknown) => Promise<Response | void>;
  onRequest: (ctx: unknown) => Promise<Response>;
};
const runRoom = (await import("../../routes/ws/run/[runId].ws"))
  .default as unknown as RoomDef;
const projectRoom = (await import("../../routes/ws/project/[projectId].ws"))
  .default as unknown as RoomDef;

const SECRET = "internal-secret";
const summary = {
  totalTests: 1,
  expectedTotalTests: null,
  passed: 1,
  failed: 0,
  flaky: 0,
  skipped: 0,
  durationMs: 5,
  status: "running",
  completedAt: null,
};

function requestCtx(opts: {
  method?: string;
  secret?: string | null;
  body?: unknown;
}): { ctx: unknown; broadcast: ReturnType<typeof vi.fn> } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.secret != null) headers[INTERNAL_HEADER] = opts.secret;
  const request = new Request("https://void.local/ws/run/r1", {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const broadcast = vi.fn(() => Promise.resolve());
  return { ctx: { request, room: { broadcast } }, broadcast };
}

function connectCtx(opts: {
  connections?: number;
  userId?: string | null;
  params?: Record<string, string>;
  origin?: string;
  /** The upgrade's own Host header; defaults to the dashboard's host. */
  host?: string;
}): unknown {
  const conns = Array.from({ length: opts.connections ?? 0 }, () => ({}));
  const user =
    opts.userId === undefined
      ? { id: "u1", email: "u@x.io" }
      : opts.userId === null
        ? null
        : { id: opts.userId, email: "u@x.io" };
  // A bare Headers (not a real Request): happy-dom's Request applies the
  // fetch spec's forbidden-header filtering and silently strips `Origin`,
  // which a real WS upgrade carries. The hooks only read `request.headers`.
  return {
    request: {
      headers: new Headers({
        host: opts.host ?? "dashboard.example",
        ...(opts.origin === undefined ? {} : { origin: opts.origin }),
      }),
    },
    room: { getConnections: () => conns },
    params: opts.params ?? { runId: "r1" },
    user,
  };
}

beforeEach(() => {
  authorizeSpy.mockReset();
  authorizeSpy.mockResolvedValue({ ok: true });
});

describe("run room onRequest (forged-broadcast gate)", () => {
  it("405s a non-POST", async () => {
    const { ctx, broadcast } = requestCtx({ method: "GET" });
    const res = await runRoom.onRequest(ctx);
    expect(res.status).toBe(405);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("403s a POST with no internal secret", async () => {
    const { ctx, broadcast } = requestCtx({ secret: null, body: {} });
    const res = await runRoom.onRequest(ctx);
    expect(res.status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("403s a POST with the wrong secret", async () => {
    const { ctx, broadcast } = requestCtx({ secret: "nope", body: {} });
    const res = await runRoom.onRequest(ctx);
    expect(res.status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("400s a POST whose body fails the server schema (no broadcast)", async () => {
    const { ctx, broadcast } = requestCtx({
      secret: SECRET,
      body: { type: "progress", changedTests: "not-array", summary },
    });
    const res = await runRoom.onRequest(ctx);
    expect(res.status).toBe(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts a valid event with the correct secret (200)", async () => {
    const event = { type: "progress", changedTests: [], summary };
    const { ctx, broadcast } = requestCtx({ secret: SECRET, body: event });
    const res = await runRoom.onRequest(ctx);
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]![0]).toMatchObject({ type: "progress" });
  });
});

describe("run room onBeforeConnect (origin + tenant + capacity gate)", () => {
  it("403s a cross-site Origin before consulting authz (defense in depth)", async () => {
    const res = await runRoom.onBeforeConnect(
      connectCtx({ origin: "https://evil.example" }),
    );
    expect((res as Response).status).toBe(403);
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("allows the dashboard's own Origin (WRIGHTFUL_PUBLIC_URL)", async () => {
    authorizeSpy.mockResolvedValue({ ok: true });
    const res = await runRoom.onBeforeConnect(
      connectCtx({ origin: "https://dashboard.example" }),
    );
    expect(res).toBeUndefined();
  });

  it("allows a same-origin upgrade on a second legitimate host (Origin matches the request's own Host)", async () => {
    // workers.dev alias / custom-domain / dev-port deployments: the Origin
    // isn't WRIGHTFUL_PUBLIC_URL but DOES equal the host the upgrade hit.
    authorizeSpy.mockResolvedValue({ ok: true });
    const res = await runRoom.onBeforeConnect(
      connectCtx({
        origin: "https://wrightful.workers.dev",
        host: "wrightful.workers.dev",
      }),
    );
    expect(res).toBeUndefined();
  });

  it("403s a cross-site Origin even on a non-canonical host (evil.com ≠ Host)", async () => {
    const res = await runRoom.onBeforeConnect(
      connectCtx({
        origin: "https://evil.example",
        host: "wrightful.workers.dev",
      }),
    );
    expect((res as Response).status).toBe(403);
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("allows an upgrade with no Origin header (non-browser client)", async () => {
    authorizeSpy.mockResolvedValue({ ok: true });
    const res = await runRoom.onBeforeConnect(connectCtx({}));
    expect(res).toBeUndefined();
  });

  it("429s when the room is at capacity (without consulting authz)", async () => {
    const res = await runRoom.onBeforeConnect(
      connectCtx({ connections: ROOM_CONNECTION_CAP }),
    );
    expect((res as Response).status).toBe(429);
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("403s when authz denies, with the run:<id> topic + userId", async () => {
    authorizeSpy.mockResolvedValue({ ok: false, status: 403 });
    const res = await runRoom.onBeforeConnect(
      connectCtx({ userId: "u1", params: { runId: "run-42" } }),
    );
    expect((res as Response).status).toBe(403);
    expect(authorizeSpy).toHaveBeenCalledWith("u1", "run:run-42");
  });

  it("allows (returns void) when authz allows", async () => {
    authorizeSpy.mockResolvedValue({ ok: true });
    const res = await runRoom.onBeforeConnect(connectCtx({ userId: "u1" }));
    expect(res).toBeUndefined();
  });

  it("passes a null userId through when there is no session user", async () => {
    await runRoom.onBeforeConnect(connectCtx({ userId: null }));
    expect(authorizeSpy).toHaveBeenCalledWith(null, "run:r1");
  });
});

describe("project room (shares the same gates, project: topic)", () => {
  it("403s onRequest without the secret", async () => {
    const { ctx, broadcast } = requestCtx({ secret: null, body: {} });
    const res = await projectRoom.onRequest(ctx);
    expect(res.status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts a valid run-progress event with the secret", async () => {
    const event = { type: "run-progress", runId: "r1", summary };
    const { ctx, broadcast } = requestCtx({ secret: SECRET, body: event });
    const res = await projectRoom.onRequest(ctx);
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("onBeforeConnect authorizes the project:<id> topic", async () => {
    authorizeSpy.mockResolvedValue({ ok: true });
    await projectRoom.onBeforeConnect(
      connectCtx({ userId: "u1", params: { projectId: "proj-9" } }),
    );
    expect(authorizeSpy).toHaveBeenCalledWith("u1", "project:proj-9");
  });

  it("onBeforeConnect 403s a cross-site Origin before consulting authz", async () => {
    const res = await projectRoom.onBeforeConnect(
      connectCtx({
        origin: "https://evil.example",
        params: { projectId: "proj-9" },
      }),
    );
    expect((res as Response).status).toBe(403);
    expect(authorizeSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { z } from "zod";
import {
  INTERNAL_HEADER,
  ROOM_CONNECTION_CAP,
  defineGuardedRoom,
} from "@/realtime/room-server";

/**
 * `defineGuardedRoom` — the single factory that owns BOTH `void/ws` room gates
 * (the connect-time origin → capacity → tenant-authz gate and the publish-time
 * POST → constant-time-secret → server-schema-parse → broadcast gate). The
 * per-room `.ws.ts` files collapse to one declaration each, so the orchestration
 * is exercised once, thoroughly, against the factory — with injected fakes
 * (no env, no DB, no live socket) — plus a thin per-room wiring assertion that
 * each route file feeds the factory the right topic prefix + param + schemas.
 */

const SECRET = "internal-secret";
const PUBLIC_URL = "https://dashboard.example";

/** A no-transform server schema standing in for the real room schemas. */
const serverSchema = z.object({
  type: z.literal("progress"),
  changedTests: z.custom<unknown[]>((v) => Array.isArray(v)),
  n: z.number(),
});
const clientSchema = z.object({ type: z.literal("ping") });

const validEvent = { type: "progress", changedTests: [], n: 1 };

type RoomDef = {
  messages: { client: unknown; server: unknown };
  onBeforeConnect: (ctx: unknown) => Promise<Response | void>;
  onRequest: (ctx: unknown) => Promise<Response>;
};

/** Records every `(userId, topic)` the gate consults, with a configurable verdict. */
function fakeAuthz(verdict: { ok: true } | { ok: false; status: number }) {
  const calls: Array<{ userId: string | null; topic: string }> = [];
  const fn = (userId: string | null, topic: string) => {
    calls.push({ userId, topic });
    return Promise.resolve(verdict);
  };
  return { fn, calls };
}

function makeRoom(opts?: {
  authz?: { ok: true } | { ok: false; status: number };
  secret?: () => string;
  publicUrl?: () => string;
}) {
  const authz = fakeAuthz(opts?.authz ?? { ok: true });
  const room = defineGuardedRoom({
    topicPrefix: "run",
    param: "runId",
    client: clientSchema,
    server: serverSchema,
    publicUrl: opts?.publicUrl ?? (() => PUBLIC_URL),
    internalSecret: opts?.secret ?? (() => SECRET),
    authorize: authz.fn,
  }) as unknown as RoomDef;
  return { room, authz };
}

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
  host?: string;
}): unknown {
  const conns = Array.from({ length: opts.connections ?? 0 }, () => ({}));
  const user =
    opts.userId === undefined
      ? { id: "u1", email: "u@x.io" }
      : opts.userId === null
        ? null
        : { id: opts.userId, email: "u@x.io" };
  // A bare Headers (not a real Request): happy-dom's Request strips the
  // forbidden `Origin` header that a real WS upgrade carries. The hooks only
  // read `request.headers`.
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

describe("defineGuardedRoom — publish gate (onRequest)", () => {
  it("405s a non-POST before any other check (no broadcast)", async () => {
    const { room } = makeRoom();
    const { ctx, broadcast } = requestCtx({ method: "GET" });
    const res = await room.onRequest(ctx);
    expect(res.status).toBe(405);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("403s a POST with no internal secret header", async () => {
    const { room } = makeRoom();
    const { ctx, broadcast } = requestCtx({ secret: null, body: validEvent });
    const res = await room.onRequest(ctx);
    expect(res.status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("403s a POST with the wrong secret (constant-time compare)", async () => {
    const { room } = makeRoom();
    const { ctx, broadcast } = requestCtx({ secret: "nope", body: validEvent });
    const res = await room.onRequest(ctx);
    expect(res.status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("400s a secret-bearing POST whose body fails the server schema BEFORE broadcast", async () => {
    const { room } = makeRoom();
    const { ctx, broadcast } = requestCtx({
      secret: SECRET,
      body: { type: "progress", changedTests: "not-array", n: 1 },
    });
    const res = await room.onRequest(ctx);
    expect(res.status).toBe(400);
    // The parse-before-fan-out invariant: a forged-but-authenticated malformed
    // payload never reaches viewers.
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts the PARSED body and 200s on a valid secret + valid body", async () => {
    const { room } = makeRoom();
    const { ctx, broadcast } = requestCtx({ secret: SECRET, body: validEvent });
    const res = await room.onRequest(ctx);
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]![0]).toMatchObject({ type: "progress" });
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("resolves the internal secret PER request (lazily), not at wiring time", () => {
    let resolved = 0;
    // Constructing the room must not resolve the secret (the resolver can throw
    // on misconfig; deferring it keeps that from breaking room construction).
    const { room } = makeRoom({
      secret: () => {
        resolved += 1;
        return SECRET;
      },
    });
    expect(resolved).toBe(0);
    expect(room).toBeDefined();
  });
});

describe("defineGuardedRoom — connect gate (onBeforeConnect)", () => {
  it("reads the public URL PER connect (lazily), not at wiring time", async () => {
    let reads = 0;
    // Rooms are wired at MODULE scope, where `void/env` has no Cloudflare
    // bindings — and Cloudflare runs that top-level scope to validate a
    // `versions upload`. An eager read here therefore fails the DEPLOY
    // (code 10021), which no other lane catches because nothing imports the
    // route files for real. See GuardedRoomConfig.publicUrl.
    const { room } = makeRoom({
      publicUrl: () => {
        reads += 1;
        return PUBLIC_URL;
      },
    });
    expect(reads).toBe(0);

    await room.onBeforeConnect(connectCtx({ origin: PUBLIC_URL }));
    expect(reads).toBe(1);
  });

  it("403s a cross-site Origin before consulting authz (defense in depth)", async () => {
    const { room, authz } = makeRoom();
    const res = await room.onBeforeConnect(
      connectCtx({ origin: "https://evil.example" }),
    );
    expect((res as Response).status).toBe(403);
    expect(authz.calls).toHaveLength(0);
  });

  it("allows the public URL's own Origin", async () => {
    const { room } = makeRoom();
    const res = await room.onBeforeConnect(connectCtx({ origin: PUBLIC_URL }));
    expect(res).toBeUndefined();
  });

  it("allows a same-origin upgrade on any host routed to the worker", async () => {
    const { room } = makeRoom();
    const res = await room.onBeforeConnect(
      connectCtx({
        origin: "https://app.workers.dev",
        host: "app.workers.dev",
      }),
    );
    expect(res).toBeUndefined();
  });

  it("allows an upgrade with no Origin header (non-browser client)", async () => {
    const { room } = makeRoom();
    const res = await room.onBeforeConnect(connectCtx({}));
    expect(res).toBeUndefined();
  });

  it("429s at capacity, AFTER the origin gate and WITHOUT consulting authz", async () => {
    const { room, authz } = makeRoom();
    const res = await room.onBeforeConnect(
      connectCtx({ connections: ROOM_CONNECTION_CAP }),
    );
    expect((res as Response).status).toBe(429);
    expect(authz.calls).toHaveLength(0);
  });

  it("403s when authz denies, consulting the `${prefix}:${param}` topic + userId", async () => {
    const { room, authz } = makeRoom({ authz: { ok: false, status: 403 } });
    const res = await room.onBeforeConnect(
      connectCtx({ userId: "u1", params: { runId: "run-42" } }),
    );
    expect((res as Response).status).toBe(403);
    expect(authz.calls).toEqual([{ userId: "u1", topic: "run:run-42" }]);
  });

  it("returns void (allows) when authz allows", async () => {
    const { room } = makeRoom({ authz: { ok: true } });
    const res = await room.onBeforeConnect(connectCtx({ userId: "u1" }));
    expect(res).toBeUndefined();
  });

  it("passes a null userId through when there is no session user", async () => {
    const { room, authz } = makeRoom();
    await room.onBeforeConnect(connectCtx({ userId: null }));
    expect(authz.calls).toEqual([{ userId: null, topic: "run:r1" }]);
  });

  it("propagates the authz denial status verbatim (not a hard-coded 403)", async () => {
    const { room } = makeRoom({ authz: { ok: false, status: 401 } });
    const res = await room.onBeforeConnect(connectCtx({ userId: "u1" }));
    expect((res as Response).status).toBe(401);
  });

  it("threads the configured param + prefix (a project-shaped room)", async () => {
    const authz = fakeAuthz({ ok: true });
    const room = defineGuardedRoom({
      topicPrefix: "project",
      param: "projectId",
      client: clientSchema,
      server: serverSchema,
      publicUrl: () => PUBLIC_URL,
      internalSecret: () => SECRET,
      authorize: authz.fn,
    }) as unknown as RoomDef;
    await room.onBeforeConnect(
      connectCtx({ userId: "u1", params: { projectId: "proj-9" } }),
    );
    expect(authz.calls).toEqual([{ userId: "u1", topic: "project:proj-9" }]);
  });

  it("exposes the schema pair on `messages` for `defineRoom`", () => {
    const { room } = makeRoom();
    expect(room.messages.client).toBe(clientSchema);
    expect(room.messages.server).toBe(serverSchema);
  });
});

// --- Thin per-room wiring assertions ----------------------------------------
// Each `.ws.ts` route is just a `defineRoom(defineGuardedRoom({...}))` call. The
// factory is proven above; here we only confirm each route fed it the right
// topic prefix + param + schema pair. `defineRoom` and the env/authz effects are
// mocked so the route module is importable without a live worker.

vi.mock("void/ws", () => ({ defineRoom: (def: unknown) => def }));
vi.mock("void/env", () => ({
  env: {
    REALTIME_INTERNAL_SECRET: SECRET,
    WRIGHTFUL_PUBLIC_URL: PUBLIC_URL,
  },
}));
const routeAuthzSpy =
  vi.fn<
    (
      userId: string | null,
      topic: string,
    ) => Promise<{ ok: boolean; status?: number }>
  >();
vi.mock("@/lib/authz", () => ({ authorizeTopicSubscription: routeAuthzSpy }));

const runRoom = (await import("../../../routes/ws/run/[runId].ws"))
  .default as unknown as RoomDef;
const projectRoom = (await import("../../../routes/ws/project/[projectId].ws"))
  .default as unknown as RoomDef;

describe("per-room wiring (route files delegate to the factory)", () => {
  beforeEach(() => {
    routeAuthzSpy.mockReset();
    routeAuthzSpy.mockResolvedValue({ ok: true });
  });

  it("run room wires param=runId, prefix=run, and the run schemas", async () => {
    await runRoom.onBeforeConnect(
      connectCtx({ userId: "u1", params: { runId: "run-7" } }),
    );
    expect(routeAuthzSpy).toHaveBeenCalledWith("u1", "run:run-7");
    // The server schema is the run room's (a flat `progress` object).
    const parsed = (
      runRoom.messages.server as {
        safeParse: (v: unknown) => { success: boolean };
      }
    ).safeParse({ type: "progress" });
    expect(parsed.success).toBe(false); // missing summary/changedTests
  });

  it("project room wires param=projectId, prefix=project, and the project schemas", async () => {
    await projectRoom.onBeforeConnect(
      connectCtx({ userId: "u1", params: { projectId: "proj-3" } }),
    );
    expect(routeAuthzSpy).toHaveBeenCalledWith("u1", "project:proj-3");
    // The server schema is the project room's discriminated union.
    const parsed = (
      projectRoom.messages.server as {
        safeParse: (v: unknown) => { success: boolean };
      }
    ).safeParse({ type: "run-progress", runId: "r1" });
    expect(parsed.success).toBe(false); // missing summary
  });

  it("both rooms 403 a forged broadcast lacking the internal secret", async () => {
    const a = requestCtx({ secret: null, body: {} });
    const b = requestCtx({ secret: null, body: {} });
    expect((await runRoom.onRequest(a.ctx)).status).toBe(403);
    expect((await projectRoom.onRequest(b.ctx)).status).toBe(403);
    expect(a.broadcast).not.toHaveBeenCalled();
    expect(b.broadcast).not.toHaveBeenCalled();
  });
});

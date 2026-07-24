import type { z } from "zod";
import type { RoomContext, RoomDefinition } from "void/ws";
import { timingSafeEqualBytes } from "@/lib/token-crypto";

/** Header carrying the internal shared secret on the server's room-publish POST. */
export const INTERNAL_HEADER = "x-wrightful-internal";

/**
 * Max concurrent connections per room Durable Object. A fan-out ceiling + abuse
 * backstop (the old SSE `defineLiveStream` had `maxSubscriptionsPerTopic: 256`;
 * `void/ws` rooms have no built-in cap, so we enforce it in `onBeforeConnect`).
 * Blast radius of the cap is one run/project room.
 */
export const ROOM_CONNECTION_CAP = 256;

/**
 * Per-build random baked into the SERVER bundle by `vite.config.ts` (`define`).
 * The publisher worker and the room DOs are one Cloudflare deployment / one
 * bundle, so this single value is identical on both sides — it authenticates the
 * DO-to-DO publish POST with zero config and auto-rotates per deploy, decoupled
 * from the session-signing secret. Absent under test/dev-without-build (the
 * `typeof` guard keeps the undeclared-global read safe); there is NO further
 * fallback — without it, `resolveInternalSecret` requires an explicit
 * `REALTIME_INTERNAL_SECRET` and otherwise throws. Read only here (a
 * server-only module), so it never reaches the client bundle.
 */
declare const __WRIGHTFUL_INTERNAL_SECRET__: string | undefined;
const BUILT_IN_SECRET: string | undefined =
  typeof __WRIGHTFUL_INTERNAL_SECRET__ === "string"
    ? __WRIGHTFUL_INTERNAL_SECRET__
    : undefined;

/**
 * Secret authenticating the server's internal room-publish POST. Precedence:
 * an explicit non-empty `REALTIME_INTERNAL_SECRET` (operator override) → the
 * per-build {@link BUILT_IN_SECRET} (zero-config default). Deliberately does NOT
 * fall back to `BETTER_AUTH_SECRET`, keeping internal-RPC decoupled from the
 * session-signing secret. An empty `REALTIME_INTERNAL_SECRET=""` is treated as
 * absent, not honored: an empty secret would let a request with an empty (also
 * absent) header pass the constant-time compare — the only gate against a forged
 * cross-tenant broadcast.
 *
 * Throws if the resolved secret is still empty/undefined — a loud
 * misconfiguration guard, better than silently authenticating with a wrong
 * secret. Can't happen in a real worker (the build always injects
 * `BUILT_IN_SECRET`); reached only in test when the explicit env is also
 * omitted, and callers (`publish.ts` try/catch, the room `onRequest`) tolerate it.
 */
export function resolveInternalSecret(source: {
  REALTIME_INTERNAL_SECRET?: string | undefined;
}): string {
  const explicit = source.REALTIME_INTERNAL_SECRET;
  const secret =
    explicit === undefined || explicit === "" ? BUILT_IN_SECRET : explicit;
  if (secret === undefined || secret === "") {
    throw new Error(
      "Realtime internal secret unavailable: build-time __WRIGHTFUL_INTERNAL_SECRET__ " +
        "was not injected and REALTIME_INTERNAL_SECRET is unset.",
    );
  }
  return secret;
}

/**
 * Constant-time check that a room-publish request carries the internal secret.
 * Void registers each room's path as a public route, so this is the ONLY gate
 * stopping a forged cross-tenant broadcast from any logged-in user. Compared in
 * constant time via {@link timingSafeEqualBytes} — consistent with the project's
 * other secret compares (api-key, artifact-tokens) — rather than a
 * short-circuiting `!==`.
 */
export function isInternalRequest(request: Request, secret: string): boolean {
  const provided = request.headers.get(INTERNAL_HEADER);
  // An empty header must never match: with a misconfigured empty secret, both
  // sides encode to zero-length arrays and pass the compare (defense in depth
  // on top of the resolver rejecting "").
  if (provided === null || provided.length === 0) return false;
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(provided), encoder.encode(secret));
}

/**
 * Cross-site WebSocket defense in depth for the rooms' `onBeforeConnect`: when
 * the upgrade carries an `Origin` header (browsers always send one on WS
 * upgrades), it must be SAME-ORIGIN with the upgrade request itself — the
 * `Origin` host equals `requestHost` (the request's own `Host` header). The
 * worker serves the pages and the WS from the same host, so a legitimate
 * browser tab satisfies this on ANY domain routed to the worker (workers.dev
 * alias, custom domain, dev port), while a hostile page's cross-site upgrade
 * never can. `WRIGHTFUL_PUBLIC_URL`'s origin is additionally accepted as
 * belt-and-braces (e.g. an upgrade proxied with a rewritten Host).
 *
 * Without this gate, a cross-site WS is blocked only by SameSite cookie
 * defaults stripping the session — a browser behavior, not a guarantee. An
 * ABSENT `Origin` is allowed: non-browser clients omit it and carry no ambient
 * cookie authority to abuse. A malformed `Origin` rejects; a malformed public
 * URL just disables the belt-and-braces branch.
 */
export function isAllowedWsOrigin(
  origin: string | null,
  requestHost: string | null,
  publicUrl: string,
): boolean {
  if (origin === null) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  // Same-origin: the browser tab that opened the socket was served from the
  // very host the upgrade hit. `URL.host` includes a non-default port, exactly
  // like the `Host` header.
  if (requestHost !== null && originUrl.host === requestHost) return true;
  try {
    return originUrl.origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

/**
 * True once a room already holds {@link ROOM_CONNECTION_CAP} connections, so
 * `onBeforeConnect` can reject the next upgrade with a 429. Counts lazily and
 * stops at the cap (no full materialization of the connection set).
 */
export function roomAtCapacity(connections: Iterable<unknown>): boolean {
  const iterator = connections[Symbol.iterator]();
  let count = 0;
  while (!iterator.next().done) {
    count += 1;
    if (count >= ROOM_CONNECTION_CAP) return true;
  }
  return false;
}

/** Outcome of {@link authorizeTopicSubscription} — the room's tenant gate. */
type AuthzDecision = { ok: true } | { ok: false; status: number };

/**
 * Everything {@link defineGuardedRoom} needs to spell ONE room's gate. The
 * orchestration (gate order, status codes, the parse-before-broadcast
 * invariant, constant-time secret compare) lives in the factory; a room varies
 * only in these four config fields plus its injected effects.
 *
 * Effects (`env`, `authorize`) are INJECTED rather than imported here so this
 * module stays import-light: `@/lib/authz` would drag in `void/db` (node-postgres,
 * bundler-hostile under the pool-workers test lane that imports this file), and
 * `void/env` is a build-time virtual. The `.ws.ts` route files already import
 * both at their (DO-only) boundary and pass them in, which also makes the factory
 * a pure function — unit-testable with fakes, no DB / env mock.
 */
export interface GuardedRoomConfig<
  ClientSchema extends z.ZodType,
  ServerSchema extends z.ZodType,
> {
  /** Topic namespace — `"run"` | `"project"`; the topic is `${topicPrefix}:${id}`. */
  topicPrefix: string;
  /** The dynamic route param naming the room's id (e.g. `"runId"`, `"projectId"`). */
  param: string;
  /** Receive-only client schema (the room is server-push; client is a no-op `ping`). */
  client: ClientSchema;
  /** Server-event schema — broadcast payloads are parsed through it before fan-out. */
  server: ServerSchema;
  /** Resolved deployment origin allowlist source (`env.WRIGHTFUL_PUBLIC_URL`). */
  publicUrl: string;
  /**
   * Internal-publish secret resolver, called per publish request inside the
   * `onRequest` gate (NOT at wiring time) — exactly as the hand-spelled rooms
   * called `resolveInternalSecret(env)` inline. `resolveInternalSecret` can
   * throw on a missing secret; deferring it to the publish path keeps a
   * misconfiguration from breaking room CONNECTS, and the platform's `onRequest`
   * dispatch is resilient to the throw.
   */
  internalSecret: () => string;
  /** Tenant gate — `authorizeTopicSubscription`, bound at the route boundary. */
  authorize: (userId: string | null, topic: string) => Promise<AuthzDecision>;
}

/**
 * The single source of truth for a `void/ws` room's security orchestration —
 * both gates, spelled once. Each `.ws.ts` route collapses to one declaration of
 * its `topicPrefix` / `param` / schema pair; this owns the rest so a security
 * tweak is a one-file change that cannot silently skip a room.
 *
 * Returns the room definition body (`messages` + `onBeforeConnect` + `onRequest`)
 * for the route file to pass straight to `defineRoom` — it does NOT call
 * `defineRoom` itself, keeping this module decoupled from the `void/ws` runtime
 * (only its types are imported, type-only) so the pool-workers test lane can
 * import it cleanly.
 *
 * Behaviour preserved EXACTLY from the hand-spelled rooms:
 *   - connect gate (`onBeforeConnect`): Origin same-origin/public-URL → 403,
 *     then capacity → 429, then tenant authz → its status (403), each
 *     short-circuiting; allow ⇒ `undefined`.
 *   - publish gate (`onRequest`): non-POST → 405, then constant-time internal
 *     secret → 403, then server-schema `safeParse` of the body → 400, and only
 *     then `broadcast` → `{ ok: true }` (200). The body is parsed BEFORE fan-out
 *     so a malformed forged-but-secret-bearing payload never reaches viewers.
 */
export function defineGuardedRoom<
  ClientSchema extends z.ZodType,
  ServerSchema extends z.ZodType,
>(
  config: GuardedRoomConfig<ClientSchema, ServerSchema>,
): Omit<RoomDefinition<ClientSchema, ServerSchema>, "__kind"> {
  type Ctx = RoomContext<z.input<ServerSchema>>;
  return {
    messages: { client: config.client, server: config.server },

    // Origin first (cross-site browser upgrades rejected outright, not left to
    // SameSite cookie defaults), then capacity, then the tenant gate — each
    // short-circuits so authz is never consulted once a cheaper gate has spoken.
    async onBeforeConnect(ctx: Ctx) {
      const origin = ctx.request.headers.get("origin");
      const host = ctx.request.headers.get("host");
      if (!isAllowedWsOrigin(origin, host, config.publicUrl)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (roomAtCapacity(ctx.room.getConnections())) {
        return new Response("Too Many Requests", { status: 429 });
      }
      const decision = await config.authorize(
        ctx.user?.id ?? null,
        `${config.topicPrefix}:${ctx.params[config.param]}`,
      );
      if (!decision.ok) {
        return new Response("Forbidden", { status: decision.status });
      }
    },

    // The publish path is a public route, so the constant-time internal-secret
    // check is the ONLY gate against a forged cross-tenant broadcast. The body
    // is parsed through the server schema (not asserted) and rejected 400 before
    // any fan-out, so a malformed payload never reaches viewers.
    async onRequest(ctx: Ctx) {
      if (ctx.request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (!isInternalRequest(ctx.request, config.internalSecret())) {
        return new Response("Forbidden", { status: 403 });
      }
      const parsed = config.server.safeParse(await ctx.request.json());
      if (!parsed.success) {
        return new Response("Bad Request", { status: 400 });
      }
      // `broadcast` is typed on the schema's INPUT (via `RoomContext`), while
      // `parsed.data` is its OUTPUT. The room schemas are pure validators with no
      // transforms, so input ≡ output; the cast bridges the two equal generic
      // sides exactly as the hand-spelled rooms did with their concrete schemas.
      await ctx.room.broadcast(parsed.data as z.input<ServerSchema>);
      return Response.json({ ok: true });
    },
  };
}

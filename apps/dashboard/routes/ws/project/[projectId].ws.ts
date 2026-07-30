import { defineRoom } from "void/ws";
import { env } from "void/env";
import { authorizeTopicSubscription } from "@/lib/authz";
import {
  projectRoomClientSchema,
  projectRoomServerSchema,
} from "@/realtime/events";
import {
  defineGuardedRoom,
  resolveInternalSecret,
} from "@/realtime/room-server";

/**
 * Runs-list live feed over a hibernatable `void/ws` room — one Durable Object
 * per project (`projectId=<id>`), shared by all viewers of that project's runs
 * list. Server-push only: clients receive `run-created` / `run-progress` and
 * never send (the client schema is a no-op `ping`).
 *
 * The room hibernates when idle (no events) — see docs/adr/0001 — so an
 * open-but-idle list tab bills ~0 duration. Kept strictly heartbeat-free +
 * presence-free so that idle-hibernation property holds.
 *
 * The security orchestration (origin → capacity → tenant authz on connect; POST
 * → constant-time secret → server-schema parse → broadcast on publish) lives
 * once in `defineGuardedRoom`; this file only wires the topic prefix, the route
 * param, and the schema pair, and hands in the env/authz effects.
 */
export default defineRoom(
  defineGuardedRoom({
    topicPrefix: "project",
    param: "projectId",
    client: projectRoomClientSchema,
    server: projectRoomServerSchema,
    publicUrl: () => env.WRIGHTFUL_PUBLIC_URL,
    internalSecret: () => resolveInternalSecret(env),
    authorize: authorizeTopicSubscription,
  }),
);

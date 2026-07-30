import { defineRoom } from "void/ws";
import { env } from "void/env";
import { authorizeTopicSubscription } from "@/lib/authz";
import { runRoomClientSchema, runRoomServerSchema } from "@/realtime/events";
import {
  defineGuardedRoom,
  resolveInternalSecret,
} from "@/realtime/room-server";

/**
 * Run-detail live feed over a hibernatable `void/ws` room — one Durable Object
 * per run (`runId=<id>`), shared by everyone viewing that run. Carries the
 * fine-grained `progress` event (summary + changed per-test rows); see
 * docs/adr/0001.
 *
 * Server-push only + heartbeat-free + presence-free, so the room hibernates when
 * idle (a run streams for minutes; a detail tab can stay open far longer).
 *
 * The security orchestration (origin → capacity → tenant authz on connect; POST
 * → constant-time secret → server-schema parse → broadcast on publish) lives
 * once in `defineGuardedRoom`; this file only wires the topic prefix, the route
 * param, and the schema pair, and hands in the env/authz effects.
 */
export default defineRoom(
  defineGuardedRoom({
    topicPrefix: "run",
    param: "runId",
    client: runRoomClientSchema,
    server: runRoomServerSchema,
    publicUrl: () => env.WRIGHTFUL_PUBLIC_URL,
    internalSecret: () => resolveInternalSecret(env),
    authorize: authorizeTopicSubscription,
  }),
);

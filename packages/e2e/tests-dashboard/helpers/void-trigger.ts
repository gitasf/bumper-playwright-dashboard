/**
 * Thin client for Void's authenticated production trigger endpoints. The E2E
 * fixture compiles an ephemeral `__VOID_PROXY_TOKEN` into its build, then these
 * requests send that token as `x-void-internal` so cron and queue handlers can
 * be driven deterministically without waiting on Cloudflare delivery.
 *
 * `POST /__void/scheduled` invokes the matching `crons/*.ts` handler and awaits
 * it. `POST /__void/queue` invokes the matching `queues/*.ts` consumer and
 * returns its per-message ack/retry decisions. Both paths execute inside the
 * built Worker served by `vp preview`.
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";

/** Shape the consumer returns per message in the `/__void/queue` response. */
export interface QueueDecisions {
  ok: boolean;
  decisions?: Record<
    string,
    { action: "ack" | "retry"; delaySeconds?: number }
  >;
}

/** A single message envelope for `/__void/queue`. `body` is the queue's `<T>`. */
export interface QueueMessageEnvelope<T = unknown> {
  id: string;
  timestamp: number;
  body: T;
  attempts: number;
}

/** Fire one cron tick through the built Worker's scheduled dispatcher. */
export async function triggerScheduled(
  request: APIRequestContext,
  baseUrl: string,
  token: string,
  cron: string,
  scheduledTime = Date.now(),
): Promise<void> {
  const res = await request.post("/__void/scheduled", {
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "x-void-internal": token,
    },
    data: { cron, scheduledTime },
    failOnStatusCode: false,
    timeout: 30_000,
  });
  await assertOk(res, "/__void/scheduled");
}

/** Dispatch a batch synchronously and return the consumer's ack/retry decisions. */
export async function triggerQueue<T = unknown>(
  request: APIRequestContext,
  baseUrl: string,
  token: string,
  queue: string,
  messages: Array<QueueMessageEnvelope<T>>,
): Promise<QueueDecisions> {
  const res = await request.post("/__void/queue", {
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "x-void-internal": token,
    },
    data: { queue, messages },
    failOnStatusCode: false,
    timeout: 30_000,
  });
  await assertOk(res, "/__void/queue");
  return (await res.json()) as QueueDecisions;
}

async function assertOk(res: APIResponse, label: string): Promise<void> {
  if (!res.ok()) {
    throw new Error(
      `${label} returned ${res.status()}: ${await res.text()} ` +
        `(401 usually means a wrong/missing x-void-internal token)`,
    );
  }
}

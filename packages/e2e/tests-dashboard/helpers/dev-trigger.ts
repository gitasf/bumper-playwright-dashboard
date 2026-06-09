/**
 * Thin client for Void's dev-only trigger endpoints, used to drive cron + queue
 * handlers deterministically in a test without waiting on real Cloudflare cron
 * ticks or native queue delivery.
 *
 * In default Void mode the dev server mounts:
 *   - `POST /__void/scheduled` `{ cron, scheduledTime }` — invokes the matching
 *     `crons/*.ts` handler (matched by exact cron string) and awaits it, so the
 *     sweep + its `queues.*.send(...)` complete before the response. Returns
 *     `{ ok: true }`. (Miniflare then natively delivers any enqueued messages to
 *     the consumer, so the full schedule→queue→ingest pipeline runs off this one
 *     call.)
 *   - `POST /__void/queue` `{ queue, messages[] }` — invokes the matching
 *     `queues/*.ts` consumer synchronously with the supplied messages and
 *     returns `{ ok, decisions: { <msgId>: { action: "ack" | "retry" } } }`.
 *
 * Both require the `x-void-dev-trigger` header to equal the project's persisted
 * dev-trigger token (see `dashboard-fixture.ts` → `devTriggerToken`).
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

/**
 * Fire one cron tick. `cron` must match a string exported from a `crons/*.ts`
 * file (the sweep cron is `"* * * * *"`). Throws on a non-2xx so a bad token /
 * unmatched cron surfaces loudly rather than as a silent no-op.
 */
export async function triggerScheduled(
  request: APIRequestContext,
  baseUrl: string,
  token: string,
  cron: string,
): Promise<void> {
  const res = await request.post("/__void/scheduled", {
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "x-void-dev-trigger": token,
    },
    data: { cron, scheduledTime: Date.now() },
    failOnStatusCode: false,
  });
  await assertOk(res, "/__void/scheduled");
}

/**
 * Dispatch a batch to a queue consumer synchronously. Returns the per-message
 * ack/retry decisions the consumer made — `runMonitorJob` acks a job whose
 * execution row is missing, which is the deterministic contract the spec
 * asserts on without needing a real (DB-resident) execution id.
 */
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
      "x-void-dev-trigger": token,
    },
    data: { queue, messages },
    failOnStatusCode: false,
  });
  await assertOk(res, "/__void/queue");
  return (await res.json()) as QueueDecisions;
}

async function assertOk(res: APIResponse, label: string): Promise<void> {
  if (!res.ok()) {
    throw new Error(
      `${label} returned ${res.status()}: ${await res.text()} ` +
        `(401 usually means a wrong/missing x-void-dev-trigger token)`,
    );
  }
}

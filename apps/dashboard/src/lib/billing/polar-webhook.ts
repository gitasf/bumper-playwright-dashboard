/**
 * Polar webhook → `teams` billing-mirror writers (the BillingProvider mutation
 * boundary; consumed by auth.ts's webhooks() plugin config). This file + the
 * provider adapter are part of the app-owned billing glue isolated behind the
 * BillingProvider seam, so it can later move to a private overlay with no
 * call-site change.
 *
 * Writer model: subscription.active / order.paid / subscription.revoked each
 * write the mirror, guarded by `billingUpdatedAt` (apply-if-newer) so out-of-order
 * delivery cannot resurrect cancelled access. subscription.canceled is status-only
 * (D4: keep tier=pro until period end). Team is resolved from metadata.referenceId
 * (set as `referenceId` at checkout, D8). Unresolved teamId → logger.error + ack.
 *
 * These handlers only run when billing is ON (the plugin is registered only when
 * billingEnabled is true), so there's no off-state guard here.
 */
import { and, db, eq, isNull, lte, or } from "void/db";
import { logger } from "void/log";
import type { Order } from "@polar-sh/sdk/models/components/order";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import { teams } from "@schema";
import { polarDateToSeconds } from "@/lib/billing/polar-time";
import { changedRows } from "@/lib/db-batch";

interface MirrorWrite {
  teamId: string;
  incomingAt: number; // modifiedAt (fallback createdAt), epoch-seconds — the ordering key
  set: Partial<{
    tier: string;
    subscriptionStatus: string;
    polarCustomerId: string;
    polarSubscriptionId: string | null;
    currentPeriodEnd: number | null;
  }>;
}

// Apply-if-newer ordering guard, expressed as ONE DB-serialized UPDATE rather
// than SELECT-then-UPDATE. Two webhooks delivered concurrently (each on its own
// pooled connection) must not both read the same stale `billingUpdatedAt`, both
// pass the guard, and let the later-committing write win by wall-clock order —
// that would resurrect cancelled access, the exact failure this guard exists to
// prevent. The conditional WHERE makes the read-and-decide atomic with the write.
// A 0-row result is either a missing team or a stale event; a cheap existence
// probe on that path preserves the two distinct log lines.
async function applyMirror({
  teamId,
  incomingAt,
  set,
}: MirrorWrite): Promise<void> {
  const res = await db
    .update(teams)
    .set({ ...set, billingUpdatedAt: incomingAt })
    .where(
      and(
        eq(teams.id, teamId),
        or(
          isNull(teams.billingUpdatedAt),
          lte(teams.billingUpdatedAt, incomingAt),
        ),
      ),
    );
  if (changedRows(res) > 0) return;
  const rows = await db
    .select({ billingUpdatedAt: teams.billingUpdatedAt })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (rows.length === 0) {
    logger.error("polar webhook: team not found", { teamId });
    return;
  }
  logger.warn("polar webhook: stale event ignored", {
    teamId,
    incomingAt,
    stored: rows[0]?.billingUpdatedAt ?? 0,
  });
}

// `payload.data` is a Subscription/Order; metadata.referenceId carries teamId (D8).
// metadata values are `MetadataOutputType = string | number | boolean` (fact 10),
// so referenceId is NOT statically a string — narrow it with `typeof`. The param
// type below is a structural supertype both Subscription.metadata and Order.metadata
// satisfy (their `{ [k]: string|number|boolean }` is assignable to it).
function resolveTeamId(data: {
  metadata: Record<string, string | number | boolean>;
}): string | null {
  const ref = data.metadata.referenceId;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

// Every Polar event → mirror write runs through here: resolve the team, ack + log on
// an unresolved reference, derive the apply-if-newer ordering key (modifiedAt, then
// createdAt), then apply the event's `set`. The resolve / guard / ordering-key rules
// live in ONE place so the four exported handlers below collapse to their `set`
// mapping. `data` is the structural shape both `Subscription` and `Order` satisfy.
async function writeMirrorEvent(
  type: string,
  data: {
    id: string;
    metadata: Record<string, string | number | boolean>;
    modifiedAt?: Date | string | null;
    createdAt?: Date | string | null;
  },
  set: MirrorWrite["set"],
): Promise<void> {
  const teamId = resolveTeamId(data);
  if (!teamId) {
    logger.error("polar webhook: unresolved teamId", { type, id: data.id });
    return;
  }
  await applyMirror({
    teamId,
    incomingAt:
      polarDateToSeconds(data.modifiedAt) ??
      polarDateToSeconds(data.createdAt) ??
      0,
    set,
  });
}

// `Subscription`/`Order` are the real @polar-sh/sdk component types (imported above
// from their per-file subpaths; fact 10). Do NOT use `any`. The plugin passes the
// full Webhook*Payload, which is a structural supertype of `{ data: … }`. Each handler
// is registered as a named callback in auth.ts's `webhooks({ … })`, so the four
// exports stay — only their `set` mapping differs.
export function onSubscriptionActive(payload: {
  data: Subscription;
}): Promise<void> {
  const sub = payload.data;
  return writeMirrorEvent("subscription.active", sub, {
    tier: "pro",
    subscriptionStatus: "active",
    polarCustomerId: sub.customerId,
    polarSubscriptionId: sub.id,
    currentPeriodEnd: polarDateToSeconds(sub.currentPeriodEnd),
  });
}

export function onOrderPaid(payload: { data: Order }): Promise<void> {
  // Renewal: refresh paid-through + keep pro. Period end on an order lives on its
  // subscription; undefined leaves the existing period untouched (Drizzle skips it).
  const order = payload.data;
  return writeMirrorEvent("order.paid", order, {
    tier: "pro",
    subscriptionStatus: "active",
    polarCustomerId: order.customerId,
    currentPeriodEnd:
      polarDateToSeconds(order.subscription?.currentPeriodEnd) ?? undefined,
  });
}

// D4: status-only. Do NOT touch tier or currentPeriodEnd — they keep pro until revoked.
export function onSubscriptionCanceled(payload: {
  data: Subscription;
}): Promise<void> {
  return writeMirrorEvent("subscription.canceled", payload.data, {
    subscriptionStatus: "canceled",
  });
}

// D4: the ONLY tier downgrade path.
export function onSubscriptionRevoked(payload: {
  data: Subscription;
}): Promise<void> {
  const sub = payload.data;
  return writeMirrorEvent("subscription.revoked", sub, {
    tier: "free",
    subscriptionStatus: "revoked",
    polarSubscriptionId: null,
  });
}

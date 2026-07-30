// The single source of truth for status → bucket MEMBERSHIP, shared by the two
// code paths that must agree on it:
//
//   - the UI presentation collapse (`@/lib/status`: `statusGroupKey` / the
//     `STATUS` registry), used for grouping, counts, and filter chips, and
//   - the server-side per-test aggregate (`@/lib/ingest`: `STATUS_BUCKET_MEMBERS`
//     → the JS delta path + the SQL recompute).
//
// This module is DEPENDENCY-FREE on purpose: `ingest.ts` is server-only (pulls
// in `void/db` / realtime) and `status.ts` is imported by ~10 client islands, so
// neither may import the other. A shared leaf both can import is the only way to
// single-source the membership without crossing that boundary. Previously each
// side hand-listed the rows and only cross-referencing comments + per-side
// canaries kept them aligned — a shared-row edit on one side (e.g. moving
// `timedout` out of `failed`) would have passed CI while the other side silently
// diverged. Now both derive from `STATUS_BUCKETS`.
//
// `STATUS_BUCKETS` is the SUPERSET. The UI uses it verbatim. Ingest's per-test
// aggregate uses it MINUS the wire-invisible statuses (see `WIRE_INVISIBLE_STATUSES`):
// `interrupted` never appears on the per-test wire enum — the reporter normalises
// interrupted attempts to `skipped`, so it only occurs as a run-level terminal
// status, which the per-test aggregate buckets never see. The UI, by contrast,
// must render `interrupted` wherever a run status appears, so it keeps that row.

/** The four user-facing buckets statuses collapse into for grouping/counts. */
export type StatusGroupKey = "passed" | "failed" | "flaky" | "skipped";

/**
 * Status → bucket membership, the superset shared by the UI and ingest. Each
 * bucket lists the raw statuses that collapse into it. `as const` so the literal
 * members are pinned (the canaries assert the exact shape).
 */
export const STATUS_BUCKETS = {
  passed: ["passed"],
  failed: ["failed", "timedout"],
  flaky: ["flaky", "interrupted"],
  skipped: ["skipped"],
} as const satisfies Record<StatusGroupKey, readonly string[]>;

/**
 * Statuses that exist at the run level but NEVER on the per-test wire enum, so
 * ingest's per-test aggregate must exclude them while the UI keeps them. The one
 * member today is `interrupted` (the reporter maps interrupted attempts to
 * `skipped`); `ingest.ts` derives `STATUS_BUCKET_MEMBERS` as `STATUS_BUCKETS`
 * minus this set, and a canary asserts that relationship holds.
 */
export const WIRE_INVISIBLE_STATUSES: ReadonlySet<string> = new Set([
  "interrupted",
]);

/**
 * The wire-visible subset of {@link STATUS_BUCKETS}: what ingest's per-test
 * aggregate buckets over, i.e. the superset minus {@link WIRE_INVISIBLE_STATUSES}.
 * Derived rather than hand-listed so it cannot drift from the UI's membership.
 *
 * Lives here beside `STATUS_BUCKETS` — not in the ingest pipeline — because it
 * is pure derived data with no server dependencies, and because the whole point
 * of this module is that the taxonomy has ONE home. Ingest's SQL recompute and
 * the run-page aggregate reads both import it from here.
 */
export const STATUS_BUCKET_MEMBERS = {
  passed: STATUS_BUCKETS.passed.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  failed: STATUS_BUCKETS.failed.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  flaky: STATUS_BUCKETS.flaky.filter((s) => !WIRE_INVISIBLE_STATUSES.has(s)),
  skipped: STATUS_BUCKETS.skipped.filter(
    (s) => !WIRE_INVISIBLE_STATUSES.has(s),
  ),
} satisfies Record<StatusGroupKey, readonly string[]>;

/**
 * Invert a bucket→statuses table into a status→bucket lookup. Shared by both
 * maps below so the inversion (and the one cast `Object.entries` forces) exists
 * in exactly one place.
 */
function reverseIndex(
  buckets: Record<StatusGroupKey, readonly string[]>,
): ReadonlyMap<string, StatusGroupKey> {
  return new Map(
    Object.entries(buckets).flatMap(([bucket, statuses]) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Object.entries erases literal key types
      statuses.map((status) => [status, bucket as StatusGroupKey] as const),
    ),
  );
}

const STATUS_TO_BUCKET = reverseIndex(STATUS_BUCKET_MEMBERS);

/**
 * The bucket a WIRE status collapses into for ingest's per-test aggregate, or
 * `null` for anything unbucketed (`queued`/`running`).
 *
 * Sibling of {@link statusGroupKey}, and the one-line difference between them is
 * deliberately visible here rather than split across two modules: this one is
 * built from the wire-visible subset, so `interrupted` returns `null`, while the
 * UI's `statusGroupKey` maps it to `flaky`.
 */
export function statusBucket(status: string): StatusGroupKey | null {
  return STATUS_TO_BUCKET.get(status) ?? null;
}

/** Reverse lookup: raw status → its display bucket, derived from {@link STATUS_BUCKETS}. */
const STATUS_TO_GROUP = reverseIndex(STATUS_BUCKETS);

/**
 * The display bucket a status collapses into for counts/filtering
 * (`timedout → failed`, `interrupted → flaky`), or `null` for any status not in
 * a bucket — importantly `"queued"`/`"running"` (in-flight placeholders) return
 * `null` so an in-progress run never inflates the four user-facing chips.
 * Callers skip `null` when accumulating counts or applying a status filter.
 */
export function statusGroupKey(status: string): StatusGroupKey | null {
  return STATUS_TO_GROUP.get(status) ?? null;
}

/**
 * Pure encode/decode + resolution for a monitor's `alertTargets` column. No IO,
 * so the "who gets alerted" policy is unit-testable on its own; `alerts.tsx`
 * supplies the live membership + group data and does the sending.
 *
 * Storage contract (`monitors.alertTargets`, a `jsonb` column):
 *   - `null`            ⇒ ALL current team members (the default).
 *   - `{ users, groups }` ⇒ those specific members + the members of those
 *     groups, unioned and re-intersected with live memberships at read time
 *     (so a removed member or a deleted group can't leak or linger).
 *
 * Since the column is `jsonb`, the driver hands back the already-parsed value —
 * `buildAlertTargets` writes the object directly and `parseAlertTargets`
 * validates/normalizes what comes back (no JSON encode/decode either side).
 */

export interface AlertTargets {
  /** Explicitly selected member user ids. */
  users: string[];
  /** Selected `memberGroups` ids; expanded to their members at send time. */
  groups: string[];
}

/**
 * Normalize the stored `jsonb` value into a well-formed {@link AlertTargets}.
 * The input is the already-parsed column value (or a request-shaped object);
 * `null`/non-object ⇒ `null` (= all members, the safe default), and each field
 * is filtered to a string array so a malformed/schema-evolved row can't leak a
 * non-string id downstream.
 */
export function parseAlertTargets(raw: unknown): AlertTargets | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as { users?: unknown; groups?: unknown };
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return { users: strings(obj.users), groups: strings(obj.groups) };
}

/**
 * Build targets from a recipient-form submission. `mode !== "specific"` (i.e.
 * "all members") ⇒ `null`. Otherwise the de-duplicated explicit selection —
 * an empty specific selection is preserved as "nobody" (distinct from "all").
 */
export function buildAlertTargets(
  mode: string,
  userIds: string[],
  groupIds: string[],
): AlertTargets | null {
  if (mode !== "specific") return null;
  return { users: [...new Set(userIds)], groups: [...new Set(groupIds)] };
}

/**
 * Resolve targets to the concrete set of member user ids to notify. Pure: the
 * caller passes the live member ids and the selected groups' member ids.
 *   - `null` ⇒ all members.
 *   - else   ⇒ (explicit users ∪ group members) ∩ live members.
 * The final intersection is what drops stale ids (a member who left, a group
 * member no longer on the team).
 */
export function resolveTargetUserIds(
  targets: AlertTargets | null,
  memberUserIds: string[],
  groupMemberUserIds: string[],
): string[] {
  if (targets === null) return memberUserIds;
  const wanted = new Set([...targets.users, ...groupMemberUserIds]);
  return memberUserIds.filter((id) => wanted.has(id));
}

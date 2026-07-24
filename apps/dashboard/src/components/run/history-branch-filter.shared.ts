/**
 * URL sentinel for "don't filter by branch". Picked to be unambiguously
 * distinct from any real git branch name.
 *
 * Lives in a plain module (not the "use client" filter component) so that
 * server-side imports get the actual string, not an RSC client reference.
 */
export const ALL_BRANCHES = "__all__";

/**
 * Decode a raw `?branch=` query param into a branch filter for the analytics
 * loaders, where an absent value or the {@link ALL_BRANCHES} sentinel both mean
 * "no branch filter". Returns `null` to filter nothing, or the branch name.
 *
 * Co-located with the sentinel it interprets so the value and its decode rule
 * have a single owner — bumping {@link ALL_BRANCHES} updates both at once.
 *
 * Note: the run-detail loader (`runs/[runId]`) decodes differently — a missing
 * param falls back to the run's own branch rather than no-filter — so it does
 * NOT use this helper.
 */
export function parseBranchParam(
  raw: string | null | undefined,
): string | null {
  return !raw || raw === ALL_BRANCHES ? null : raw;
}

/**
 * Single source of truth for the slug length cap. `SLUG_RE` and `SLUG_ERROR`
 * derive from it, and `provisioning.ts` (slugifyName / suffix trimming)
 * imports it — change it here and everything stays in lockstep.
 */
export const SLUG_MAX_LEN = 40;

// First + last chars are pinned to [a-z0-9], so the middle run is capped at
// SLUG_MAX_LEN - 2.
export const SLUG_RE = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,${SLUG_MAX_LEN - 2}}[a-z0-9])?$`,
);

export const SLUG_ERROR = `Slug must be 1–${SLUG_MAX_LEN} lowercase alphanumerics and hyphens, starting and ending with a letter or number.`;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

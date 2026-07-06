/**
 * Client-side payload caps + truncation.
 *
 * The dashboard hard-REJECTS an oversized `title` (identity field) and would 400
 * the whole open/`/results` call; and although it truncates free-form
 * `errorMessage`/`errorStack`/annotation `description` server-side, a
 * multi-megabyte assertion diff can 413 the whole request body BEFORE it's
 * parsed. Both failures lose real test results non-retryably. So the reporter
 * clamps these fields itself, mirroring the dashboard caps.
 *
 * These constants MIRROR the dashboard's `MAX` (`apps/dashboard/src/lib/schemas.ts`)
 * — the reporter must not take a runtime dependency on the dashboard package, so
 * `contract.test.ts` pins them against the dashboard's exported `MAX` (a cap the
 * dashboard tightens without the reporter tracking it would otherwise surface
 * only as a production 400/413).
 */
export const MAX_TITLE = 2048;
export const MAX_MESSAGE = 65_536;
export const MAX_STACK = 131_072;

/**
 * Truncate `s` to at most `max` UTF-16 code units, byte-for-byte matching the
 * dashboard's `truncatedText` transform — including its surrogate-pair guard: a
 * cut that would leave a lone high surrogate is pulled back one unit so the
 * result stays well-formed UTF-16/UTF-8 (a lone surrogate breaks JSON
 * serialization). Lossy by design — a truncated stack beats a lost result.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const lastKept = s.charCodeAt(max - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

/** {@link truncate} that passes `null`/`undefined` through as `null`. */
export function truncateNullable(
  s: string | null | undefined,
  max: number,
): string | null {
  return s == null ? null : truncate(s, max);
}

/**
 * The one opaque keyset-cursor wire codec: base64 over `:`-joined segments.
 * Previously hand-rolled three times (`decodeCursor` / `decodeRankedCursor` in
 * `run-results-page.ts`, `decodeGroupCursor` in `run-groups-page.ts`) with a
 * drifted malformed-input guard — `decodeCursor` rejected an empty leading
 * segment while `decodeGroupCursor` accepted it, decoding `":key"` to
 * `{severity: 0, key}`. Concentrating the codec here gives every cursor ONE
 * uniform malformed→null rule; callers keep their own numeric coercion
 * (`Number.isFinite`) and final-segment semantics.
 */

/** Encode cursor segments as an opaque base64 `a:b[:c…]` string. */
export function encodeKeyset(segments: readonly string[]): string {
  return btoa(segments.join(":"));
}

/**
 * Decode an opaque keyset cursor back into exactly `arity` segments, or `null`
 * for any malformed input so callers degrade to first-page (the lenient
 * behaviour every cursor consumer shares).
 *
 * Splits on the first `arity - 1` separators only — the FINAL segment is "the
 * rest", so a free-form trailing value (a ULID id, a file-path group key) may
 * itself contain `:`. Malformed→null covers: empty input, invalid base64, too
 * few segments, and an empty NON-final segment (every non-final segment is a
 * sort-key component — rank / timestamp / severity — so an empty one can only
 * be a corrupt cursor; `Number("")` is 0, which would otherwise decode
 * silently). Whether the final segment may be empty is a per-caller call
 * (a row cursor's id must be non-empty; a group cursor's `""` key is the
 * legitimate NULL-fallback group).
 */
export function decodeKeyset(
  raw: string | null,
  arity: number,
): string[] | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i < arity - 1; i++) {
    const sep = decoded.indexOf(":", start);
    if (sep === -1) return null;
    if (sep === start) return null; // empty non-final segment
    segments.push(decoded.slice(start, sep));
    start = sep + 1;
  }
  segments.push(decoded.slice(start));
  return segments;
}

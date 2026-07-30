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

/**
 * base64 over the UTF-8 bytes, NOT over the code units. `btoa` only accepts
 * code points ≤ U+00FF, so encoding straight from the joined string throws for
 * any cursor carrying a non-Latin-1 group key — a spec file named
 * `テスト.spec.ts`, a project named `Chrome 移动端` — and paging that group
 * would 500. ASCII bytes are identical either way, so cursors already in flight
 * keep decoding.
 */
function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Inverse of {@link encodeUtf8Base64}. `fatal` so a cursor whose bytes are not
 * valid UTF-8 throws here and reaches the caller's malformed→null path, rather
 * than silently decoding to U+FFFD mojibake that would never match a real
 * group key.
 *
 * Deliberately UNVERSIONED, which expires the one class of cursor this cannot
 * read: a pre-UTF-8 cursor over a Latin-1 key (`btoa("4:value:café")` wrote a
 * bare 0xE9). Those decode to null and the paginator falls back to first page —
 * the same degradation every malformed cursor already gets, and a cursor only
 * lives as long as an open page. The alternative, a Latin-1 fallback decoder,
 * would still mis-read a legacy key whose bytes happen to be valid UTF-8
 * (`"Ã©"` → `"é"`), so it buys a wrong page boundary rather than a right one.
 * A version tag is the only complete fix and is not worth carrying forever for
 * a window that closes on the next click. Pinned by the tests.
 */
function decodeUtf8Base64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Encode cursor segments as an opaque base64 `a:b[:c…]` string. */
export function encodeKeyset(segments: readonly string[]): string {
  return encodeUtf8Base64(segments.join(":"));
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
    decoded = decodeUtf8Base64(raw);
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

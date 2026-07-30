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
import { StringDecoder } from "node:string_decoder";

export const MAX_TITLE = 2048;
export const MAX_MESSAGE = 65_536;
export const MAX_STACK = 131_072;

/** Dashboard request caps mirrored and pinned by the contract tests. */
export const MAX_RESULTS_PER_BATCH = 5000;
export const MAX_PLANNED_TESTS = 100_000;
const STDIO_DECODE_SLICE_BYTES = 16 * 1024;
const STDIO_STRING_SLICE_UNITS = 8 * 1024;

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

/**
 * Join Playwright's per-attempt `TestResult.stdout`/`stderr` — an
 * `Array<string | Buffer>` of the chunks written during that attempt — into a
 * single UTF-8 string, truncated to `max` like every other free-form field so
 * a chatty `console.log` loop can't 413 the ingest batch.
 *
 * Returns `null` when there is nothing captured (missing array, empty array, or
 * an array that decodes to the empty string) so the wire carries an explicit
 * `null` rather than `""` — the dashboard column is nullable and the two
 * surfaces (reporter + Zod schema) agree on "no output === null".
 *
 * All chunks are decoded via one `StringDecoder("utf8")` shared across the
 * array: Playwright can split a UTF-8 codepoint across two chunks at any byte
 * boundary, and per-chunk `toString("utf8")` would mangle the split into
 * replacement chars. String chunks are re-encoded before they enter the
 * decoder so an incomplete byte buffered from an earlier chunk is resolved in
 * emission order instead of being carried past the string and completed by a
 * later buffer. Chunks join with no separator (Playwright's chunks carry their
 * own newlines). Accumulation stops once output reaches `max` so a runaway
 * `console.log` can't balloon the heap before truncation.
 */
export function joinStdio(
  chunks: ReadonlyArray<string | Buffer> | undefined | null,
  max: number,
): string | null {
  if (chunks == null || chunks.length === 0 || max <= 0) return null;
  const decoder = new StringDecoder("utf8");
  let out = "";

  const writeBytes = (bytes: Buffer): void => {
    for (let offset = 0; offset < bytes.length && out.length < max;) {
      const remainingUnits = max - out.length;
      // A UTF-8 codepoint is at most four bytes. Never inspect an unbounded
      // suffix of one giant Buffer merely to retain a bounded string prefix.
      const usefulBytes = remainingUnits * 4 + 3;
      const end = Math.min(
        bytes.length,
        offset + STDIO_DECODE_SLICE_BYTES,
        offset + usefulBytes,
      );
      out += decoder.write(bytes.subarray(offset, end));
      offset = end;
    }
  };

  for (const chunk of chunks) {
    if (typeof chunk !== "string") {
      writeBytes(chunk);
      if (out.length >= max) break;
      continue;
    }

    // Encoding an entire multi-megabyte string would allocate another
    // multi-megabyte Buffer before truncation. Encode only bounded slices,
    // keeping surrogate pairs together at slice boundaries.
    for (let offset = 0; offset < chunk.length && out.length < max;) {
      const remainingUnits = max - out.length;
      let end = Math.min(
        chunk.length,
        offset + STDIO_STRING_SLICE_UNITS,
        offset + remainingUnits + 1,
      );
      const last = chunk.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff && end < chunk.length) end += 1;
      writeBytes(Buffer.from(chunk.slice(offset, end), "utf8"));
      offset = end;
    }
    if (out.length >= max) break;
  }
  out += decoder.end();
  if (out.length === 0) return null;
  return truncate(out, max);
}

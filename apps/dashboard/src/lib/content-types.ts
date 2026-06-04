/**
 * Artifact MIME types that are safe to serve from the dashboard's own origin.
 *
 * Anything outside this set is normalised to `application/octet-stream` at
 * download time and rejected at registration. The point is to make sure a
 * compromised or hostile API key cannot store an artifact with
 * `contentType: "text/html"` (or `image/svg+xml`, which can carry script)
 * and trick a teammate into rendering attacker-controlled HTML/JS on the
 * dashboard's origin.
 *
 * This allowlist is one of two artifact-serving origin-safety defenses that
 * must stay consistent (the silent-drift risk the policy test below guards):
 *   1. THIS allowlist — caps what content-type the download endpoint will ever
 *      emit (everything else falls back to `application/octet-stream`), and the
 *      download handler additionally forces `Content-Disposition: attachment`
 *      (see `buildArtifactHeaders` in `src/lib/artifacts.ts`).
 *   2. The Content-Security-Policy in `apps/dashboard/void.json` — its
 *      `img-src 'self' data: blob:` deliberately does NOT permit a renderable
 *      type to *execute* (`object-src 'none'`, `frame-ancestors 'none'`).
 * If you ever widen this set to add a renderable/executable type, the download
 * leg must keep forcing attachment and the CSP must keep forbidding execution.
 * `src/__tests__/artifact-origin-safety.test.ts` cross-checks both so a change
 * to one leg without the other fails loudly instead of silently.
 */
export const SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set<string>([
  // Trace bundles
  "application/zip",
  "application/x-zip-compressed",
  // Generic binary + structured payloads (PDFs, JSON dumps, error context, …)
  "application/octet-stream",
  "application/json",
  "application/pdf",
  // Plain-text logs / error context / copy-prompt payloads
  "text/plain",
  "text/csv",
  "text/markdown",
  // Screenshots + visual diffs. SVG is intentionally excluded — it can carry
  // <script> and would execute on the dashboard origin.
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  // Video recordings
  "video/webm",
  "video/mp4",
  "video/ogg",
  // Audio (used in some custom attachments)
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
]);

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * Strip parameters (`; charset=…`, `; boundary=…`) and lower-case so an
 * allowlist lookup matches `Image/PNG`, `image/png; charset=utf-8`, and
 * plain `image/png` alike.
 */
function normaliseContentType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function isSafeContentType(value: string): boolean {
  return SAFE_CONTENT_TYPES.has(normaliseContentType(value));
}

/**
 * Return `value` if it's a known-safe MIME type, otherwise the fallback.
 * Used by the artifact download/upload paths so a malformed or hostile row
 * never serves as `text/html` from the dashboard's origin.
 */
export function safeContentType(value: string): string {
  const base = normaliseContentType(value);
  return SAFE_CONTENT_TYPES.has(base) ? base : FALLBACK_CONTENT_TYPE;
}

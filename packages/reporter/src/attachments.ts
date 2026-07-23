import { realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";

// Playwright attachment → Wrightful artifact-type mapping, plus path-safety
// helpers used by the reporter before uploading local files to R2.

export type ArtifactType =
  | "trace"
  | "screenshot"
  | "video"
  | "visual"
  | "other";

export type SnapshotRole = "expected" | "actual" | "diff";

export interface SnapshotAttachmentMeta {
  snapshotName: string;
  role: SnapshotRole;
}

/**
 * Mirror of the dashboard's artifact content-type allowlist
 * (apps/dashboard/src/lib/content-types.ts) — the repo's established
 * duplicate-and-canary contract pattern; `contract.test.ts` asserts the two
 * sets stay identical. The register endpoint rejects an ENTIRE batch when any
 * single item carries a non-allowlisted contentType, so the reporter
 * normalises every attachment up-front instead of letting one odd type poison
 * the batch.
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
 * Mirror of the dashboard's replay-eligibility policy. The reporter and
 * dashboard cannot share runtime code, so `contract.test.ts` keeps these
 * tuples and their predicates in lockstep across the package boundary.
 */
export const REPLAY_TRACE_ARTIFACT_NAMES = ["trace", "trace.zip"] as const;
export const REPLAY_TRACE_CONTENT_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
] as const;

/**
 * Map an attachment's contentType onto the dashboard-safe set: strip
 * parameters (`; charset=…`), lower-case, and fall back to
 * `application/octet-stream` for anything not on the allowlist (matching what
 * the dashboard would serve it as anyway).
 */
export function normalizeContentType(value: string): string {
  const base = value.split(";", 1)[0].trim().toLowerCase();
  return SAFE_CONTENT_TYPES.has(base) ? base : FALLBACK_CONTENT_TYPE;
}

export function isReplayTraceAttachment(
  name: string,
  contentType: string,
): boolean {
  const normalized = normalizeContentType(contentType);
  return (
    REPLAY_TRACE_ARTIFACT_NAMES.some((candidate) => candidate === name) &&
    REPLAY_TRACE_CONTENT_TYPES.some((candidate) => candidate === normalized)
  );
}

/**
 * Detects Playwright snapshot attachments produced by `toHaveScreenshot()`
 * (and image variants of `toMatchSnapshot()`). Playwright names them
 * `{baseName}-(expected|actual|diff).png`. Returns the trimmed `snapshotName`
 * (e.g. `hero-chromium-linux`) and the role; null otherwise.
 *
 * Returning a match here is *not* sufficient to classify the attachment as
 * `visual` — the reporter additionally requires all three roles to be
 * present in the same `(testId, attempt)` set before promoting the type
 * (see `collectArtifacts` in index.ts). A user-named `foo-actual.png` from
 * `testInfo.attach()` falls back to `screenshot` via that gate.
 */
export function parseSnapshotAttachment(
  filename: string,
): SnapshotAttachmentMeta | null {
  const base = basename(filename);
  const match = /^(.+)-(expected|actual|diff)\.png$/.exec(base);
  if (!match) return null;
  return {
    // The dashboard caps snapshotName at 255 chars; truncating here keeps the
    // triple's grouping key consistent across all three roles.
    snapshotName: match[1].slice(0, 255),
    role: match[2] as SnapshotRole,
  };
}

export function classifyAttachment(
  name: string,
  contentType: string,
): ArtifactType {
  const ct = contentType.toLowerCase();
  if (isReplayTraceAttachment(name, contentType)) return "trace";
  if (ct.startsWith("image/")) return "screenshot";
  if (ct.startsWith("video/")) return "video";

  const ext = extname(name).toLowerCase();
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
    return "screenshot";
  }
  if (ext === ".webm" || ext === ".mp4") return "video";
  return "other";
}

/**
 * Defends against a hostile playwright.config.ts pointing an attachment at a
 * CI secret file via symlink and exfiltrating it through the artifact upload.
 * Resolves via realpath and requires the result to live under `allowedRoot`.
 */
export async function safeResolvedPath(
  attachmentPath: string,
  allowedRoot: string,
): Promise<string | null> {
  try {
    const resolved = await realpath(attachmentPath);
    const rootWithSep = allowedRoot.endsWith(sep)
      ? allowedRoot
      : allowedRoot + sep;
    if (resolved !== allowedRoot && !resolved.startsWith(rootWithSep)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

export async function safeSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return null;
  }
}

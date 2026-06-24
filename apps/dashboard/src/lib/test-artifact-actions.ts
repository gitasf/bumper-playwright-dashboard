import { asc, db } from "void/db";
import { env } from "void/env";
import { artifacts } from "@schema";
import type { ArtifactAction } from "@/components/artifact-actions";
import {
  ARTIFACT_TOKEN_TTL_SECONDS,
  signArtifactToken,
  signedDownloadHref,
  signedTraceViewerUrl,
  traceViewerUrlFor,
} from "@/lib/artifact-tokens";
import { artifactContentDisposition } from "@/lib/artifacts";
import { signGetUrl } from "@/lib/artifacts/presign";
import { r2DirectConfig } from "@/lib/config";
import { safeContentType } from "@/lib/content-types";
import { childByTestResultWhere, type TenantScope } from "@/lib/scope";

// Order within an attempt: trace first (most useful for debugging), then the
// visual diff (groups three images into one entry), video, screenshot,
// everything else. `other` covers error-context / copy-prompt artifacts that
// aren't rendered in the action row. This is the SINGLE ordering map shared by
// the run-detail row and the test-detail rail — the test-detail page used to
// keep its own 5-slot copy with a `visual` slot the lib lacked; that copy is
// gone and the lib now emits visual actions too.
const TYPE_ORDER: Record<string, number> = {
  trace: 0,
  visual: 1,
  video: 2,
  screenshot: 3,
  other: 4,
};

function compareByTypeThenName(
  a: { type: string; name: string },
  b: { type: string; name: string },
): number {
  const da = TYPE_ORDER[a.type] ?? 99;
  const db_ = TYPE_ORDER[b.type] ?? 99;
  if (da !== db_) return da - db_;
  return a.name.localeCompare(b.name);
}

/**
 * An artifact row whose download capability has already been minted server-side
 * — `href` is the signed download URL, `traceViewerUrl` is set for traces. The
 * pure presentation transforms (`buildAttemptArtifactGroups`) operate on these
 * so token minting / DB access stays out of the orderable/groupable core. The
 * raw `r2Key` does NOT appear as a field here, and `href` never embeds it. One
 * exception when the direct-R2 path is on (ADR 0003): a trace's `traceViewerUrl`
 * wraps a presigned R2 object URL, whose path contains the `r2Key` — an
 * intentional, scoped read capability (the viewer's own tenant), not a leak.
 */
export interface SignedArtifact {
  id: string;
  type: string;
  name: string;
  contentType: string;
  attempt: number;
  role: string | null;
  snapshotName: string | null;
  href: string;
  traceViewerUrl?: string;
}

/**
 * Fold the `visual` frame rows for a single snapshot into one grouped
 * `ArtifactAction` carrying expected/actual/diff. The frames are keyed by
 * `role`; any missing frame (typically a timeout) is null. The action's own
 * `downloadHref` prefers the diff, then the actual frame.
 */
export function toVisualArtifactAction(
  rows: readonly SignedArtifact[],
): ArtifactAction {
  const first = rows[0];
  const byRole = new Map(rows.map((r) => [r.role, r] as const));
  const frame = (
    role: "expected" | "actual" | "diff",
  ): { href: string; name: string } | null => {
    const r = byRole.get(role);
    return r ? { href: r.href, name: r.name } : null;
  };
  return {
    id: `visual::${first.attempt}::${first.snapshotName}`,
    type: "visual",
    name: first.snapshotName ?? "snapshot",
    contentType: "image/png",
    downloadHref: frame("diff")?.href ?? frame("actual")?.href ?? "",
    visualGroup: {
      snapshotName: first.snapshotName ?? "snapshot",
      expected: frame("expected"),
      actual: frame("actual"),
      diff: frame("diff"),
    },
  };
}

/** Ready-to-render artifact presentation for a single attempt of a test. */
export interface AttemptArtifactGroup {
  attempt: number;
  /** Trace/video/screenshot + grouped visual actions, ordered by TYPE_ORDER. */
  media: ArtifactAction[];
  /** The `other` (copy-prompt / error-context) artifact, if present. */
  copyPrompt: ArtifactAction | null;
}

/**
 * Pure presentation transform: group signed artifact rows by attempt and, for
 * each attempt, fold the `visual` frames into one action, pull out the
 * `copyPrompt` (`other`) artifact, and order the remaining media by the shared
 * `TYPE_ORDER` then name. This is the orderable/groupable core the test-detail
 * rail used to hand-roll inline (its own TYPE_ORDER + toAction + toVisualAction)
 * — kept pure so it can be unit-tested without a DB or a React render.
 */
export function buildAttemptArtifactGroups(
  rows: readonly SignedArtifact[],
): Map<number, AttemptArtifactGroup> {
  const byAttempt = new Map<number, SignedArtifact[]>();
  for (const row of rows) {
    const bucket = byAttempt.get(row.attempt) ?? [];
    bucket.push(row);
    byAttempt.set(row.attempt, bucket);
  }

  const out = new Map<number, AttemptArtifactGroup>();
  for (const [attempt, bucket] of byAttempt) {
    const copyPromptRow = bucket.find((a) => a.type === "other");
    const copyPrompt = copyPromptRow ? signedToAction(copyPromptRow) : null;

    const nonVisual = bucket
      .filter((a) => a.type !== "other" && a.type !== "visual")
      .map(signedToAction);

    const visualByName = new Map<string, SignedArtifact[]>();
    for (const a of bucket) {
      if (a.type !== "visual" || !a.snapshotName) continue;
      const frames = visualByName.get(a.snapshotName) ?? [];
      frames.push(a);
      visualByName.set(a.snapshotName, frames);
    }
    const visual = Array.from(visualByName.values()).map(
      toVisualArtifactAction,
    );

    const media = [...nonVisual, ...visual].sort(compareByTypeThenName);
    out.set(attempt, { attempt, media, copyPrompt });
  }
  return out;
}

/** A `SignedArtifact` is already an `ArtifactAction` minus the visual group. */
function signedToAction(a: SignedArtifact): ArtifactAction {
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    contentType: a.contentType,
    downloadHref: a.href,
    traceViewerUrl: a.traceViewerUrl,
  };
}

/** Columns every artifact-presentation read needs (raw, pre-sign). */
const ARTIFACT_PRESENTATION_COLUMNS = {
  id: artifacts.id,
  testResultId: artifacts.testResultId,
  type: artifacts.type,
  name: artifacts.name,
  contentType: artifacts.contentType,
  attempt: artifacts.attempt,
  r2Key: artifacts.r2Key,
  role: artifacts.role,
  snapshotName: artifacts.snapshotName,
} as const;

type RawArtifactRow = {
  id: string;
  testResultId: string;
  type: string;
  name: string;
  contentType: string;
  attempt: number;
  r2Key: string;
  role: string | null;
  snapshotName: string | null;
};

/**
 * Mint a download token per row and project it to a `SignedArtifact`. The raw
 * `r2Key` is consumed HERE (to sign the token, and — when the direct-R2 path is
 * on — to mint the presigned trace URL) and dropped from the returned shape. The
 * in-page `href` therefore never embeds the key; the only place it surfaces is a
 * trace's direct-R2 `traceViewerUrl` (a scoped presigned capability — see the
 * `SignedArtifact` docstring).
 */
async function signArtifactRows(
  rows: readonly RawArtifactRow[],
  origin: string,
): Promise<SignedArtifact[]> {
  // When the direct-R2 path is configured (ADR 0003), the trace viewer gets a
  // presigned R2 GET URL embedded DIRECTLY (not the worker download href). The
  // viewer fetches cross-origin from trace.playwright.dev; embedding the final
  // R2 URL avoids making it follow a cross-origin 302 (which would need CORS on
  // both the redirect and the object). The in-page `href` stays the worker
  // download route either way — same-origin, so its redirect-mint is clean.
  const directCfg = r2DirectConfig(env);
  return Promise.all(
    rows.map(async (a) => {
      const token = await signArtifactToken({
        r2Key: a.r2Key,
        contentType: a.contentType,
      });
      let traceViewerUrl: string | undefined;
      if (a.type === "trace") {
        traceViewerUrl = directCfg
          ? traceViewerUrlFor(
              await signGetUrl(directCfg, a.r2Key, {
                responseContentType: safeContentType(a.contentType),
                // Force attachment like the 302 + worker-proxy paths (ADR 0003
                // point 4). Inert for the viewer's cross-origin fetch, but keeps
                // the origin-safety invariant if the bare URL is opened directly.
                responseContentDisposition: artifactContentDisposition(a.r2Key),
                // Bound the bare SigV4 capability to the artifact-token lifetime
                // (this URL is embedded in SSR HTML, unmediated) — explicit, not
                // the signer's default, and matched to the co-minted `token`.
                expiresIn: ARTIFACT_TOKEN_TTL_SECONDS,
              }),
            )
          : signedTraceViewerUrl(origin, a.id, token);
      }
      return {
        id: a.id,
        type: a.type,
        name: a.name,
        contentType: a.contentType,
        attempt: a.attempt,
        role: a.role,
        snapshotName: a.snapshotName,
        href: signedDownloadHref(a.id, token),
        traceViewerUrl,
      } satisfies SignedArtifact;
    }),
  );
}

/**
 * Server-owned artifact-presentation seam for the TEST-DETAIL page. Fetches the
 * single test result's artifact rows, mints download tokens server-side, and
 * returns finished, per-attempt `AttemptArtifactGroup`s (media ordered by the
 * shared `TYPE_ORDER`, visual frames already grouped, the copy-prompt artifact
 * pulled out). The page renders these directly — it no longer sees raw rows,
 * `r2Key`, or the token map, and no longer re-implements ordering / visual
 * grouping inline.
 */
export async function loadAttemptArtifactGroups(
  scope: TenantScope,
  testResultId: string,
  origin: string,
): Promise<Map<number, AttemptArtifactGroup>> {
  const rows = await db
    .select(ARTIFACT_PRESENTATION_COLUMNS)
    .from(artifacts)
    .where(childByTestResultWhere(artifacts, scope, testResultId))
    .orderBy(asc(artifacts.attempt));

  const signed = await signArtifactRows(rows, origin);
  return buildAttemptArtifactGroups(signed);
}

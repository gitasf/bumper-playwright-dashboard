/**
 * Shared artifact-presentation type contract. These interfaces are the wire
 * shape the server-side seam (`@/lib/test-artifact-actions`) produces and the
 * test-detail rail (`artifacts-rail.tsx` / `visual-diff-dialog.tsx`) renders.
 *
 * The horizontal run-detail action-row component that used to live here
 * (`ArtifactActions` + its per-type buttons) was never mounted — the run-detail
 * row has no artifact-rendering host — so it was removed along with the loader
 * that fed it. Only the type contract remains.
 */

export interface VisualDiffFrame {
  href: string;
  name: string;
}

export interface VisualDiffGroup {
  /** Snapshot's base name (e.g. `hero-chromium-linux`). */
  snapshotName: string;
  /** Each frame is null if its row is missing — typically a timeout. */
  expected: VisualDiffFrame | null;
  actual: VisualDiffFrame | null;
  diff: VisualDiffFrame | null;
}

export interface ArtifactAction {
  id: string;
  type: string;
  name: string;
  contentType: string;
  downloadHref: string;
  /** Present only for type === "visual". */
  visualGroup?: VisualDiffGroup;
}

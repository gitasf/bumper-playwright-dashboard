import { describe, expect, it, vi } from "vite-plus/test";

// `test-artifact-actions.ts` imports `void/db` (for the async loaders) and,
// transitively via `artifact-tokens`, `void/env`. The functions under test
// here (`buildAttemptArtifactGroups`, `toVisualArtifactAction`) are PURE — they
// operate on already-signed rows and never touch the DB or the env — so we only
// need these module-graph deps to resolve at import time.
vi.mock("void/db", () => ({}));
vi.mock("void/env", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long-000" },
}));

const mod = await import("@/lib/test-artifact-actions");
const { buildAttemptArtifactGroups, toVisualArtifactAction } = mod;
type SignedArtifact = Parameters<typeof buildAttemptArtifactGroups>[0][number];

function signed(over: Partial<SignedArtifact>): SignedArtifact {
  return {
    id: over.id ?? "a",
    type: over.type ?? "screenshot",
    name: over.name ?? "shot.png",
    contentType: over.contentType ?? "image/png",
    attempt: over.attempt ?? 0,
    role: over.role ?? null,
    snapshotName: over.snapshotName ?? null,
    href: over.href ?? `/api/artifacts/${over.id ?? "a"}/download?t=tok`,
  };
}

/**
 * Server-owned artifact-presentation seam. The test-detail page used to
 * hand-roll this transform inline (its own 5-slot TYPE_ORDER, toAction,
 * toVisualAction) over rows that crossed the trust boundary carrying r2Key.
 * The lib now owns ordering + visual grouping + per-attempt bucketing over
 * already-signed rows. These tests pin the orderable/groupable core without a
 * DB, a React render, or any token minting.
 */
describe("buildAttemptArtifactGroups", () => {
  it("orders media trace → visual → video → screenshot within an attempt", () => {
    const rows: SignedArtifact[] = [
      signed({ id: "shot", type: "screenshot", name: "z.png" }),
      signed({ id: "vid", type: "video", name: "v.webm" }),
      signed({ id: "trace", type: "trace", name: "trace.zip" }),
      signed({
        id: "vexp",
        type: "visual",
        role: "expected",
        snapshotName: "hero",
        name: "hero-expected.png",
      }),
    ];
    const groups = buildAttemptArtifactGroups(rows);
    const media = groups.get(0)?.media ?? [];
    expect(media.map((m) => m.type)).toEqual([
      "trace",
      "visual",
      "video",
      "screenshot",
    ]);
  });

  it("folds expected/actual/diff frames of one snapshot into a single visual action", () => {
    const rows: SignedArtifact[] = [
      signed({
        id: "exp",
        type: "visual",
        role: "expected",
        snapshotName: "hero",
        name: "hero-expected.png",
        href: "/api/artifacts/exp/download?t=tok",
      }),
      signed({
        id: "act",
        type: "visual",
        role: "actual",
        snapshotName: "hero",
        name: "hero-actual.png",
        href: "/api/artifacts/act/download?t=tok",
      }),
      signed({
        id: "diff",
        type: "visual",
        role: "diff",
        snapshotName: "hero",
        name: "hero-diff.png",
        href: "/api/artifacts/diff/download?t=tok",
      }),
    ];
    const media = buildAttemptArtifactGroups(rows).get(0)?.media ?? [];
    expect(media).toHaveLength(1);
    const visual = media[0];
    expect(visual.type).toBe("visual");
    expect(visual.id).toBe("visual::0::hero");
    // Action's own href prefers the diff frame.
    expect(visual.downloadHref).toBe("/api/artifacts/diff/download?t=tok");
    expect(visual.visualGroup).toEqual({
      snapshotName: "hero",
      expected: {
        href: "/api/artifacts/exp/download?t=tok",
        name: "hero-expected.png",
      },
      actual: {
        href: "/api/artifacts/act/download?t=tok",
        name: "hero-actual.png",
      },
      diff: {
        href: "/api/artifacts/diff/download?t=tok",
        name: "hero-diff.png",
      },
    });
  });

  it("emits separate visual actions per snapshot name", () => {
    const rows: SignedArtifact[] = [
      signed({
        id: "h1",
        type: "visual",
        role: "diff",
        snapshotName: "hero",
        name: "hero.png",
      }),
      signed({
        id: "f1",
        type: "visual",
        role: "diff",
        snapshotName: "footer",
        name: "footer.png",
      }),
    ];
    const media = buildAttemptArtifactGroups(rows).get(0)?.media ?? [];
    expect(media.filter((m) => m.type === "visual")).toHaveLength(2);
  });

  it("pulls the `other` artifact out as copyPrompt, not into media", () => {
    const rows: SignedArtifact[] = [
      signed({ id: "prompt", type: "other", name: "error-context.md" }),
      signed({ id: "trace", type: "trace", name: "trace.zip" }),
    ];
    const group = buildAttemptArtifactGroups(rows).get(0);
    expect(group?.media.map((m) => m.id)).toEqual(["trace"]);
    expect(group?.copyPrompt?.id).toBe("prompt");
  });

  it("keeps only the first `other` row as copyPrompt but surfaces additional `other` rows in media, not dropped", () => {
    const rows: SignedArtifact[] = [
      signed({ id: "prompt", type: "other", name: "error-context.md" }),
      signed({ id: "extra", type: "other", name: "notes.txt" }),
      signed({ id: "trace", type: "trace", name: "trace.zip" }),
    ];
    const group = buildAttemptArtifactGroups(rows).get(0);
    expect(group?.copyPrompt?.id).toBe("prompt");
    expect(group?.media.map((m) => m.id)).toEqual(["trace", "extra"]);
  });

  it("buckets rows by attempt", () => {
    const rows: SignedArtifact[] = [
      signed({ id: "a0", type: "trace", attempt: 0 }),
      signed({ id: "a1", type: "trace", attempt: 1 }),
    ];
    const groups = buildAttemptArtifactGroups(rows);
    expect(groups.get(0)?.media.map((m) => m.id)).toEqual(["a0"]);
    expect(groups.get(1)?.media.map((m) => m.id)).toEqual(["a1"]);
    expect(groups.get(0)?.attempt).toBe(0);
    expect(groups.get(1)?.attempt).toBe(1);
  });

  it("ignores visual rows with no snapshotName (can't be grouped)", () => {
    const rows: SignedArtifact[] = [
      signed({
        id: "orphan",
        type: "visual",
        role: "diff",
        snapshotName: null,
      }),
      signed({ id: "trace", type: "trace" }),
    ];
    const media = buildAttemptArtifactGroups(rows).get(0)?.media ?? [];
    expect(media.map((m) => m.id)).toEqual(["trace"]);
  });
});

describe("module surface", () => {
  // Pruned dead exports, guarded against creeping back in as orphans:
  //  - `toArtifactAction` + `ArtifactRow`: the test-detail page's old per-row
  //    transform, dead once both detail pages routed through
  //    `buildAttemptArtifactGroups`.
  //  - `loadFailingArtifactActions` + `errorAttempt`: the run-detail
  //    single-error model, dead once the run-detail loader stopped computing
  //    artifact actions the row never rendered (it has no artifact host).
  it("no longer exports the pruned pre-grouping helpers", () => {
    expect("toArtifactAction" in mod).toBe(false);
    expect("ArtifactRow" in mod).toBe(false);
  });

  it("no longer exports the removed run-detail single-error helpers", () => {
    expect("loadFailingArtifactActions" in mod).toBe(false);
    expect("errorAttempt" in mod).toBe(false);
  });
});

describe("toVisualArtifactAction", () => {
  it("falls back to the actual frame for the action href when diff is missing", () => {
    const action = toVisualArtifactAction([
      signed({
        id: "exp",
        type: "visual",
        role: "expected",
        snapshotName: "hero",
        href: "/api/artifacts/exp/download?t=tok",
      }),
      signed({
        id: "act",
        type: "visual",
        role: "actual",
        snapshotName: "hero",
        href: "/api/artifacts/act/download?t=tok",
      }),
    ]);
    expect(action.downloadHref).toBe("/api/artifacts/act/download?t=tok");
    expect(action.visualGroup?.diff).toBeNull();
  });
});

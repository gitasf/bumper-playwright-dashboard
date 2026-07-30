import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AuthorizedProjectId,
  AuthorizedTeamId,
  TenantScope,
} from "@/lib/scope";

const listSpy = vi.fn<
  (opts: { prefix: string; limit: number }) => Promise<{
    objects: { key: string }[];
    truncated: boolean;
  }>
>();
const deleteSpy = vi.fn<(keys: string[]) => Promise<void>>();

vi.mock("void/storage", () => ({
  storage: { list: listSpy, delete: deleteSpy },
}));

const { buildArtifactR2Key, deleteProjectArtifactObjects, safeKeySegment } =
  await import("@/lib/artifacts/store");
const { filenameFromKey } = await import("@/lib/artifacts/read");

const scope: TenantScope = {
  teamId: "team-1" as AuthorizedTeamId,
  projectId: "proj-1" as AuthorizedProjectId,
  teamSlug: "acme",
  projectSlug: "web",
};

beforeEach(() => {
  listSpy.mockReset();
  deleteSpy.mockReset();
  deleteSpy.mockResolvedValue(undefined);
});

describe("deleteProjectArtifactObjects", () => {
  it("continues a prefix larger than 100 pages on the next bounded pass", async () => {
    let remainingPages = 101;
    listSpy.mockImplementation(async ({ prefix }) => ({
      objects:
        remainingPages > 0
          ? [{ key: `${prefix}object-${remainingPages}` }]
          : [],
      truncated: remainingPages > 1,
    }));
    deleteSpy.mockImplementation(async (keys) => {
      remainingPages -= keys.length;
    });

    await expect(
      deleteProjectArtifactObjects("team-1", "project-1"),
    ).resolves.toEqual({ deleted: 100, complete: false });
    expect(remainingPages).toBe(1);

    await expect(
      deleteProjectArtifactObjects("team-1", "project-1"),
    ).resolves.toEqual({ deleted: 1, complete: true });
    expect(remainingPages).toBe(0);
    expect(listSpy).toHaveBeenCalledTimes(101);
    expect(listSpy).toHaveBeenLastCalledWith({
      prefix: "t/team-1/p/project-1/",
      limit: 1000,
    });
  });

  it("resumes from the prefix head after a transient delete failure", async () => {
    const remaining = ["first", "second"];
    listSpy.mockImplementation(async ({ prefix }) => ({
      objects:
        remaining.length > 0 ? [{ key: `${prefix}${remaining[0]}` }] : [],
      truncated: remaining.length > 1,
    }));
    deleteSpy
      .mockImplementationOnce(async () => {
        remaining.shift();
      })
      .mockRejectedValueOnce(new Error("R2 unavailable"))
      .mockImplementationOnce(async () => {
        remaining.shift();
      });

    await expect(
      deleteProjectArtifactObjects("team-1", "project-1"),
    ).rejects.toThrow("R2 unavailable");
    expect(remaining).toEqual(["second"]);

    await expect(
      deleteProjectArtifactObjects("team-1", "project-1"),
    ).resolves.toEqual({ deleted: 1, complete: true });
    expect(remaining).toEqual([]);
  });
});

/**
 * The signed download token carries the R2 key rather than the original name,
 * so the key constructor and download filename parser must agree on the final
 * segment.
 */
describe("filenameFromKey ⇆ buildArtifactR2Key", () => {
  it("recovers the sanitized filename from a constructed key", () => {
    for (const name of [
      "shot.png",
      "a/b/trace.zip",
      "weird name!.txt",
      "...hidden",
    ]) {
      const key = buildArtifactR2Key(scope, "run-1", "tr-1", "art-1", name);
      expect(filenameFromKey(key)).toBe(safeKeySegment(name));
    }
  });

  it("falls back to 'artifact' for a degenerate key", () => {
    expect(filenameFromKey("")).toBe("artifact");
    expect(filenameFromKey("t/team/p/proj/runs/r/tr/art/")).toBe("artifact");
  });
});

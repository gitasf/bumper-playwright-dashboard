import { describe, it, expect, vi } from "vite-plus/test";
import {
  ArtifactUploader,
  correlateUploads,
  runWithConcurrency,
  type ArtifactBatchEntry,
} from "../artifact-uploader.js";
import type { PreparedArtifact } from "../index.js";
import type { ArtifactUpload, ResultMapping } from "../types.js";

function makeArtifact(over: Partial<PreparedArtifact> = {}): PreparedArtifact {
  return {
    type: "screenshot",
    name: "shot.png",
    contentType: "image/png",
    sizeBytes: 100,
    localPath: "/tmp/shot.png",
    attempt: 0,
    ...over,
  };
}

function makeUpload(over: Partial<ArtifactUpload> = {}): ArtifactUpload {
  return {
    artifactId: "a_1",
    uploadUrl: "https://r2.example/sig",
    r2Key: "runs/r/t",
    ...over,
  };
}

describe("correlateUploads", () => {
  it("aligns registrations[i] with locals[i] across multiple entries", () => {
    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [
          makeArtifact({ name: "a", localPath: "/p/a" }),
          makeArtifact({ name: "b", localPath: "/p/b" }),
        ],
      },
      {
        clientKey: "k2",
        artifacts: [makeArtifact({ name: "c", localPath: "/p/c" })],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
      { clientKey: "k2", testResultId: "tr_2" },
    ];

    const { registrations, locals } = correlateUploads(batch, mapping);

    expect(registrations).toHaveLength(3);
    expect(locals).toHaveLength(3);
    // Positional invariant: each registration's testResultId matches the
    // entry that produced the local at the same index.
    expect(registrations.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(locals.map((l) => l.localPath)).toEqual(["/p/a", "/p/b", "/p/c"]);
    expect(registrations.map((r) => r.testResultId)).toEqual([
      "tr_1",
      "tr_1",
      "tr_2",
    ]);
  });

  it("carries the artifact's descriptive fields into the registration", () => {
    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [
          makeArtifact({
            type: "visual",
            name: "hero-actual.png",
            contentType: "image/png",
            sizeBytes: 4096,
            attempt: 2,
            role: "actual",
            snapshotName: "hero",
          }),
        ],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_9" },
    ];

    const { registrations } = correlateUploads(batch, mapping);

    expect(registrations[0]).toEqual({
      testResultId: "tr_9",
      type: "visual",
      name: "hero-actual.png",
      contentType: "image/png",
      sizeBytes: 4096,
      attempt: 2,
      role: "actual",
      snapshotName: "hero",
    });
  });

  it("drops entries whose clientKey is missing from the mapping (in lockstep)", () => {
    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "known",
        artifacts: [makeArtifact({ name: "keep", localPath: "/p/keep" })],
      },
      {
        clientKey: "unknown",
        artifacts: [makeArtifact({ name: "drop", localPath: "/p/drop" })],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "known", testResultId: "tr_1" },
    ];

    const { registrations, locals } = correlateUploads(batch, mapping);

    // The unknown entry contributes to neither array, so index 0 still lines up.
    expect(registrations).toHaveLength(1);
    expect(locals).toHaveLength(1);
    expect(registrations[0].name).toBe("keep");
    expect(locals[0].localPath).toBe("/p/keep");
  });

  it("skips entries with no artifacts", () => {
    const batch: ArtifactBatchEntry[] = [
      { clientKey: "empty", artifacts: [] },
      { clientKey: "k1", artifacts: [makeArtifact({ name: "only" })] },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "empty", testResultId: "tr_0" },
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const { registrations } = correlateUploads(batch, mapping);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe("only");
  });

  it("returns empty arrays for an empty batch", () => {
    expect(correlateUploads([], [])).toEqual({ registrations: [], locals: [] });
  });
});

describe("runWithConcurrency", () => {
  it("runs the task for every index", async () => {
    const seen: number[] = [];
    await runWithConcurrency(5, 2, async (i) => {
      seen.push(i);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the concurrency bound of in-flight tasks", async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const run = runWithConcurrency(6, 3, (_i) => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          active--;
          resolve();
        });
      });
    });
    // Let the initial wave schedule.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(3);
    // Drain: release tasks until all six have run.
    while (resolvers.length > 0) {
      const r = resolvers.shift()!;
      r();
      await Promise.resolve();
      await Promise.resolve();
    }
    await run;
    expect(peak).toBe(3);
  });

  it("is a no-op for non-positive length", async () => {
    const task = vi.fn(async () => {});
    await runWithConcurrency(0, 4, task);
    await runWithConcurrency(-1, 4, task);
    expect(task).not.toHaveBeenCalled();
  });
});

describe("ArtifactUploader.upload", () => {
  it("registers, then PUTs each upload to its positionally-aligned local file", async () => {
    const registerArtifacts = vi.fn(async () => [
      makeUpload({ artifactId: "a_1", uploadUrl: "https://r2/u1" }),
      makeUpload({ artifactId: "a_2", uploadUrl: "https://r2/u2" }),
    ]);
    const uploadArtifact = vi.fn(
      async (_url: string, _localPath: string) => {},
    );
    const uploader = new ArtifactUploader({
      registerArtifacts,
      uploadArtifact,
    });

    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [
          makeArtifact({ name: "first", localPath: "/p/first" }),
          makeArtifact({ name: "second", localPath: "/p/second" }),
        ],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const result = await uploader.upload("run_1", batch, mapping);

    expect(result).toEqual({ ok: 2, failed: 0 });
    expect(registerArtifacts).toHaveBeenCalledWith("run_1", [
      expect.objectContaining({ name: "first", testResultId: "tr_1" }),
      expect.objectContaining({ name: "second", testResultId: "tr_1" }),
    ]);
    // uploads[0].uploadUrl pairs with locals[0].localPath, etc.
    const putByUrl = Object.fromEntries(
      uploadArtifact.mock.calls.map((c) => [c[0], c[1]]),
    );
    expect(putByUrl["https://r2/u1"]).toBe("/p/first");
    expect(putByUrl["https://r2/u2"]).toBe("/p/second");
  });

  it("counts the whole batch as failed and warns when register throws", async () => {
    const registerArtifacts = vi.fn(async () => {
      throw new Error("boom");
    });
    const uploadArtifact = vi.fn(async () => {});
    const onWarn = vi.fn();
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact },
      onWarn,
    );

    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [makeArtifact(), makeArtifact({ name: "two" })],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const result = await uploader.upload("run_1", batch, mapping);

    expect(result).toEqual({ ok: 0, failed: 2 });
    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("artifact register failed: boom"),
    );
  });

  it("counts individual PUT failures separately and warns per-file", async () => {
    const registerArtifacts = vi.fn(async () => [
      makeUpload({ uploadUrl: "https://r2/ok" }),
      makeUpload({ uploadUrl: "https://r2/bad" }),
    ]);
    const uploadArtifact = vi.fn(async (url: string) => {
      if (url === "https://r2/bad") throw new Error("put-fail");
    });
    const onWarn = vi.fn();
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact },
      onWarn,
    );

    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [
          makeArtifact({ name: "good" }),
          makeArtifact({ name: "broken" }),
        ],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const result = await uploader.upload("run_1", batch, mapping);

    expect(result).toEqual({ ok: 1, failed: 1 });
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("artifact PUT failed (broken): put-fail"),
    );
  });

  it("does not call register when there is nothing to correlate", async () => {
    const registerArtifacts = vi.fn(async () => []);
    const uploadArtifact = vi.fn(async () => {});
    const uploader = new ArtifactUploader({
      registerArtifacts,
      uploadArtifact,
    });

    const result = await uploader.upload(
      "run_1",
      [{ clientKey: "k1", artifacts: [] }],
      [{ clientKey: "k1", testResultId: "tr_1" }],
    );

    expect(result).toEqual({ ok: 0, failed: 0 });
    expect(registerArtifacts).not.toHaveBeenCalled();
  });

  it("respects the configured concurrency limit during PUTs", async () => {
    const uploads = Array.from({ length: 6 }, (_, i) =>
      makeUpload({ uploadUrl: `https://r2/u${i}` }),
    );
    const registerArtifacts = vi.fn(async () => uploads);
    let active = 0;
    let peak = 0;
    const uploadArtifact = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
    });
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact },
      () => {},
      2,
    );

    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: Array.from({ length: 6 }, (_, i) =>
          makeArtifact({ name: `f${i}`, localPath: `/p/${i}` }),
        ),
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const result = await uploader.upload("run_1", batch, mapping);

    expect(result).toEqual({ ok: 6, failed: 0 });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

import { describe, it, expect, vi } from "vite-plus/test";
import {
  ArtifactUploader,
  correlateUploads,
  Semaphore,
  type ArtifactBatchEntry,
} from "../artifact-uploader.js";
import { RegisterArtifactsError } from "../client.js";
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

describe("Semaphore", () => {
  it("admits up to `limit` holders immediately and queues the rest", async () => {
    const sem = new Semaphore(2);
    let admitted = 0;
    const hold = async () => {
      await sem.acquire();
      admitted++;
    };
    await hold();
    await hold();
    // Both slots taken; the third waits until a release.
    const third = hold();
    await Promise.resolve();
    expect(admitted).toBe(2);
    sem.release();
    await third;
    expect(admitted).toBe(3);
    sem.release();
    sem.release();
  });

  it("hands a released slot to the next waiter FIFO", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    await sem.acquire();
    const a = sem.acquire().then(() => order.push(1));
    const b = sem.acquire().then(() => order.push(2));
    sem.release();
    await a;
    sem.release();
    await b;
    expect(order).toEqual([1, 2]);
    sem.release();
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

  it("caps PUT concurrency globally across overlapping upload() calls", async () => {
    let urlSeq = 0;
    const registerArtifacts = vi.fn(async (_runId: string, regs: unknown[]) =>
      regs.map(() => makeUpload({ uploadUrl: `https://r2/u${urlSeq++}` })),
    );
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const uploadArtifact = vi.fn(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          active--;
          resolve();
        });
      });
    });
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact },
      () => {},
      2,
    );

    const batchOf = (prefix: string): ArtifactBatchEntry[] => [
      {
        clientKey: "k1",
        artifacts: Array.from({ length: 3 }, (_, i) =>
          makeArtifact({
            name: `${prefix}${i}`,
            localPath: `/p/${prefix}${i}`,
          }),
        ),
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    // Two overlapping batches: a per-call limiter would allow 2 + 2 = 4
    // concurrent PUTs; the instance-level semaphore must hold the cap at 2.
    const first = uploader.upload("run_1", batchOf("a"), mapping);
    const second = uploader.upload("run_1", batchOf("b"), mapping);
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBeLessThanOrEqual(2);

    while (resolvers.length > 0) {
      resolvers.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await first).toEqual({ ok: 3, failed: 0 });
    expect(await second).toEqual({ ok: 3, failed: 0 });
    expect(peak).toBe(2);
    expect(uploadArtifact).toHaveBeenCalledTimes(6);
  });

  it("on a 413 register, drops oversized artifacts (warning per file) and retries the rest once", async () => {
    const registerArtifacts = vi
      .fn()
      .mockRejectedValueOnce(new RegisterArtifactsError("too big", 413, 1000))
      .mockImplementationOnce(async (_runId: string, regs: unknown[]) =>
        (regs as unknown[]).map((_, i) =>
          makeUpload({ uploadUrl: `https://r2/retry${i}` }),
        ),
      );
    const uploadArtifact = vi.fn(async () => {});
    const onWarn = vi.fn();
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact },
      onWarn,
    );

    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [
          makeArtifact({
            name: "small.png",
            sizeBytes: 500,
            localPath: "/p/s",
          }),
          makeArtifact({
            name: "huge.webm",
            sizeBytes: 5000,
            localPath: "/p/h",
          }),
        ],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const result = await uploader.upload("run_1", batch, mapping);

    // The oversized file counts as failed; the survivor registers + PUTs.
    expect(result).toEqual({ ok: 1, failed: 1 });
    expect(registerArtifacts).toHaveBeenCalledTimes(2);
    expect(registerArtifacts.mock.calls[1][1]).toEqual([
      expect.objectContaining({ name: "small.png" }),
    ]);
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    expect(uploadArtifact).toHaveBeenCalledWith(
      "https://r2/retry0",
      "/p/s",
      "image/png",
    );
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("artifact dropped (huge.webm)"),
    );
  });

  it("retries the 413 register exactly once — a second failure fails the batch", async () => {
    const registerArtifacts = vi
      .fn()
      .mockRejectedValue(new RegisterArtifactsError("too big", 413, 1000));
    const uploadArtifact = vi.fn(async () => {});
    const onWarn = vi.fn();
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact },
      onWarn,
    );

    const batch: ArtifactBatchEntry[] = [
      {
        clientKey: "k1",
        artifacts: [
          makeArtifact({ name: "small.png", sizeBytes: 500 }),
          makeArtifact({ name: "huge.webm", sizeBytes: 5000 }),
        ],
      },
    ];
    const mapping: ResultMapping[] = [
      { clientKey: "k1", testResultId: "tr_1" },
    ];

    const result = await uploader.upload("run_1", batch, mapping);

    expect(result).toEqual({ ok: 0, failed: 2 });
    expect(registerArtifacts).toHaveBeenCalledTimes(2);
    expect(uploadArtifact).not.toHaveBeenCalled();
  });

  it("does not retry a 413 when every artifact is oversized", async () => {
    const registerArtifacts = vi
      .fn()
      .mockRejectedValue(new RegisterArtifactsError("too big", 413, 100));
    const onWarn = vi.fn();
    const uploader = new ArtifactUploader(
      { registerArtifacts, uploadArtifact: vi.fn(async () => {}) },
      onWarn,
    );

    const result = await uploader.upload(
      "run_1",
      [
        {
          clientKey: "k1",
          artifacts: [makeArtifact({ name: "huge.webm", sizeBytes: 5000 })],
        },
      ],
      [{ clientKey: "k1", testResultId: "tr_1" }],
    );

    expect(result).toEqual({ ok: 0, failed: 1 });
    expect(registerArtifacts).toHaveBeenCalledTimes(1);
  });
});

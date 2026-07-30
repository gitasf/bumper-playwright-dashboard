import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The `readArtifact` adapter, which maps R2's reply onto an `ArtifactRead`.
 *
 * Its sibling suite (`artifact-response.workers.test.ts`) covers the pure
 * protocol math over plain fixtures and deliberately stops at this boundary.
 * The seam worth pinning here is the one place the adapter has to RECONCILE
 * two independent decisions: R2 decides whether to send a body via `onlyIf`,
 * and `artifactConditionalOutcome` re-derives the reason so a bodyless reply
 * can be reported as 304 vs 412. Those can disagree, and what happens then is
 * not observable from the pure layer.
 */

const storageMock = {
  get: vi.fn(),
  head: vi.fn(),
};

vi.mock("void/storage", () => ({ storage: storageMock }));

const { readArtifact } = await import("@/lib/artifacts/read");

const ETAG = '"abc123"';
const UPLOADED = new Date("2026-10-21T07:28:00.000Z");

/** R2's bodyless reply: an `R2Object` with no `body` property at all. */
function bodylessObject() {
  return {
    httpEtag: ETAG,
    uploaded: UPLOADED,
    size: 1000,
    httpMetadata: {},
    writeHttpMetadata: () => undefined,
  };
}

function objectWithBody() {
  return { ...bodylessObject(), body: new ReadableStream() };
}

beforeEach(() => {
  storageMock.get.mockReset();
  storageMock.head.mockReset();
});

describe("readArtifact", () => {
  it("reports a matching If-None-Match as not-modified", async () => {
    storageMock.get.mockResolvedValue(bodylessObject());
    const result = await readArtifact(
      "k",
      new Headers({ "if-none-match": ETAG }),
      "GET",
    );
    expect(result?.outcome).toBe("not-modified");
    expect(result?.body).toBeNull();
  });

  it("reports a failed If-Match as precondition-failed", async () => {
    storageMock.get.mockResolvedValue(bodylessObject());
    const result = await readArtifact(
      "k",
      new Headers({ "if-match": '"other"' }),
      "GET",
    );
    expect(result?.outcome).toBe("precondition-failed");
  });

  // The disagreement case. R2 withheld the body, but the re-derivation sees no
  // condition that explains it and would return "body". Serving that verbatim
  // is `Response(null, 200)` still advertising content-length — malformed. The
  // adapter must fall back to the 304 this branch always used to return.
  it("falls back to not-modified when R2 withholds a body unexplained", async () => {
    storageMock.get.mockResolvedValue(bodylessObject());
    const result = await readArtifact("k", new Headers(), "GET");
    expect(result?.outcome).toBe("not-modified");
    expect(result?.body).toBeNull();
  });

  it("passes a real body through as body", async () => {
    storageMock.get.mockResolvedValue(objectWithBody());
    const result = await readArtifact("k", new Headers(), "GET");
    expect(result?.outcome).toBe("body");
    expect(result?.body).not.toBeNull();
  });

  // HEAD has no conditional-options argument on R2, so the adapter always
  // derives the outcome itself. A plain HEAD is a 200, not a 304 — the
  // fallback above must NOT bleed into this path.
  it("derives HEAD outcomes and leaves an unconditional HEAD as body", async () => {
    storageMock.head.mockResolvedValue(bodylessObject());
    await expect(
      readArtifact("k", new Headers(), "HEAD").then((r) => r?.outcome),
    ).resolves.toBe("body");

    storageMock.head.mockResolvedValue(bodylessObject());
    await expect(
      readArtifact("k", new Headers({ "if-none-match": ETAG }), "HEAD").then(
        (r) => r?.outcome,
      ),
    ).resolves.toBe("not-modified");
  });

  it("returns null when the object is missing", async () => {
    storageMock.get.mockResolvedValue(null);
    await expect(readArtifact("k", new Headers(), "GET")).resolves.toBeNull();
    storageMock.head.mockResolvedValue(null);
    await expect(readArtifact("k", new Headers(), "HEAD")).resolves.toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The flag-conditional trace-viewer fork in `signArtifactRows` (ADR 0003),
 * exercised through the exported `loadAttemptArtifactGroups`. The existing
 * test-artifact-actions.test.ts only covers the pure grouping over already-signed
 * rows and never reaches this fork. ON: a trace's `traceViewerUrl` must embed the
 * DIRECT presigned R2 URL (so the cross-origin viewer never follows a 302), with
 * the in-page `href` STILL the worker download route. OFF: the worker-proxy
 * trace URL, and the presigner is never called.
 */

let rows: unknown[] = [];
const builder = {
  from: () => builder,
  where: () => builder,
  orderBy: () => Promise.resolve(rows),
};
vi.mock("void/db", () => ({
  db: { select: () => builder },
  asc: (x: unknown) => x,
}));
vi.mock("void/env", () => ({ env: {} }));
// Real @schema (pure Drizzle table defs) loads fine; only the scope where-builder
// is stubbed so the bare void/db mock doesn't need the and/eq operators.
vi.mock("@/lib/scope", () => ({ childByTestResultWhere: () => ({}) }));

const r2DirectConfig = vi.fn();
vi.mock("@/lib/config", () => ({ r2DirectConfig }));

const signGetUrl = vi.fn();
vi.mock("@/lib/artifacts/presign", () => ({ signGetUrl }));

vi.mock("@/lib/artifact-tokens", () => ({
  ARTIFACT_TOKEN_TTL_SECONDS: 3600,
  signArtifactToken: vi.fn(async () => "TOKEN"),
  signedDownloadHref: (id: string, t: string) =>
    `/api/artifacts/${id}/download?t=${t}`,
  signedTraceViewerUrl: (o: string, id: string, t: string) =>
    `WORKER_TRACE:${o}:${id}:${t}`,
  traceViewerUrlFor: (u: string) => `DIRECT_TRACE:${u}`,
}));

const { loadAttemptArtifactGroups } =
  await import("@/lib/test-artifact-actions");

const CFG = {
  accountId: "acct",
  accessKeyId: "key",
  secretAccessKey: "secret",
  bucket: "bucket",
};
const PRESIGNED =
  "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=sig";

const traceRow = {
  id: "art-trace",
  testResultId: "tr-1",
  type: "trace",
  name: "trace.zip",
  contentType: "application/zip",
  attempt: 0,
  r2Key: "t/x/p/y/runs/r/tr-1/art-trace/trace.zip",
  role: null,
  snapshotName: null,
};

beforeEach(() => {
  r2DirectConfig.mockReset();
  signGetUrl.mockReset();
  signGetUrl.mockResolvedValue(PRESIGNED);
  rows = [traceRow];
});

describe("signArtifactRows trace-viewer fork (via loadAttemptArtifactGroups)", () => {
  it("ON: embeds the direct presigned R2 URL, signs type + disposition, keeps href on the worker route", async () => {
    r2DirectConfig.mockReturnValue(CFG);

    const groups = await loadAttemptArtifactGroups(
      {} as never,
      "tr-1",
      "https://dash.example.com",
    );
    const action = groups.get(0)?.media[0];

    expect(action?.traceViewerUrl).toBe(`DIRECT_TRACE:${PRESIGNED}`);
    expect(action?.downloadHref).toBe(
      "/api/artifacts/art-trace/download?t=TOKEN",
    );

    expect(signGetUrl).toHaveBeenCalledOnce();
    const [cfg, key, opts] = signGetUrl.mock.calls[0] as [
      unknown,
      string,
      {
        responseContentType: string;
        responseContentDisposition: string;
        expiresIn: number;
      },
    ];
    expect(cfg).toBe(CFG);
    expect(key).toBe(traceRow.r2Key);
    expect(opts.responseContentType).toBe("application/zip");
    expect(opts.responseContentDisposition).toMatch(/^attachment;/);
    // Bounded to the artifact-token lifetime, not the signer's default.
    expect(opts.expiresIn).toBe(3600);
  });

  it("OFF: uses the worker-proxy trace URL and never calls the presigner", async () => {
    r2DirectConfig.mockReturnValue(null);

    const groups = await loadAttemptArtifactGroups(
      {} as never,
      "tr-1",
      "https://dash.example.com",
    );
    const action = groups.get(0)?.media[0];

    expect(action?.traceViewerUrl).toBe(
      "WORKER_TRACE:https://dash.example.com:art-trace:TOKEN",
    );
    expect(signGetUrl).not.toHaveBeenCalled();
  });

  it("non-trace rows get no traceViewerUrl in either mode", async () => {
    rows = [{ ...traceRow, id: "art-shot", type: "screenshot", name: "s.png" }];
    r2DirectConfig.mockReturnValue(CFG);

    const groups = await loadAttemptArtifactGroups({} as never, "tr-1", "o");
    expect(groups.get(0)?.media[0]?.traceViewerUrl).toBeUndefined();
    expect(signGetUrl).not.toHaveBeenCalled();
  });
});

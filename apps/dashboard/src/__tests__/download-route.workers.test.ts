import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "hono";

/**
 * The download route's flag-conditional branch (ADR 0003): when direct-R2 is ON,
 * a verified GET 302s to a presigned R2 URL (no bytes through the worker);
 * HEAD and the OFF state fall through to `readArtifact`. These are the
 * behavior-defining glue the lib-level tests don't reach, and the regressions
 * that would silently ship (caching the redirect, routing HEAD into the
 * method-bound presigned URL, minting before verifying the token) all live here.
 */

vi.mock("void", () => ({ defineHandler: (fn: unknown) => fn }));
vi.mock("void/env", () => ({ env: {} }));

const r2DirectConfig = vi.fn();
vi.mock("@/lib/config", () => ({ r2DirectConfig }));

const verifyArtifactToken = vi.fn();
vi.mock("@/lib/artifact-tokens", () => ({ verifyArtifactToken }));

const signGetUrl = vi.fn();
vi.mock("@/lib/artifacts/presign", () => ({ signGetUrl }));

const readArtifact = vi.fn();
vi.mock("@/lib/artifacts", () => ({
  readArtifact,
  buildArtifactResponse: () => new Response("body", { status: 200 }),
  artifactContentDisposition: (key: string) =>
    `attachment; filename*=UTF-8''${key.split("/").pop()}`,
}));

const { handle } = await import("../../routes/api/artifacts/[id]/download");

const CFG = {
  accountId: "acct",
  accessKeyId: "key",
  secretAccessKey: "secret",
  bucket: "bucket",
};
const PRESIGNED =
  "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=sig";

/** Minimal Hono Context for the bits `handle` reads. */
function ctx(
  method: string,
  url: string,
  headers: Record<string, string> = {},
) {
  const raw = new Request(url, { method, headers });
  return {
    req: {
      url,
      method,
      raw,
      header: (n: string) => raw.headers.get(n) ?? undefined,
    },
  } as unknown as Context;
}

const URL_WITH_TOKEN =
  "https://dash.example.com/api/artifacts/a1/download?t=tok";

beforeEach(() => {
  r2DirectConfig.mockReset();
  verifyArtifactToken.mockReset();
  signGetUrl.mockReset();
  readArtifact.mockReset();
  signGetUrl.mockResolvedValue(PRESIGNED);
  readArtifact.mockResolvedValue(null); // fall-through → 404, proves no 302
});

describe("download route — direct-R2 branch", () => {
  it("302s a verified GET to a presigned R2 URL when ON, with no-store and no worker read", async () => {
    verifyArtifactToken.mockResolvedValue({
      r2Key: "t/x/p/y/runs/r/tr/a/shot.png",
      contentType: "image/png",
      exp: Math.floor(Date.now() / 1000) + 1000,
    });
    r2DirectConfig.mockReturnValue(CFG);

    const res = await handle(ctx("GET", URL_WITH_TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PRESIGNED);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // CORS on the 302 (no Origin header in the test → dashboard origin echoed).
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://dash.example.com",
    );
    expect(res.headers.get("vary")).toBe("Origin");
    expect(readArtifact).not.toHaveBeenCalled();
    const [, key, opts] = signGetUrl.mock.calls[0] as [
      unknown,
      string,
      {
        responseContentType: string;
        responseContentDisposition: string;
        expiresIn: number;
      },
    ];
    expect(key).toBe("t/x/p/y/runs/r/tr/a/shot.png");
    // Origin-safety overrides are signed onto the presigned GET (sanitized type +
    // forced attachment) — the redirect's whole job beyond moving the bytes.
    expect(opts.responseContentType).toBe("image/png");
    expect(opts.responseContentDisposition).toMatch(/^attachment;/);
    // Capped to the token's remaining life (~1000s here), NOT the signer's 1h
    // default — a loose `<= 1000` alone wouldn't catch the cap being dropped.
    expect(opts.expiresIn).toBeGreaterThan(900);
    expect(opts.expiresIn).toBeLessThanOrEqual(1000);
  });

  it("keeps HEAD on the worker path even when ON (presigned URL is method-bound)", async () => {
    verifyArtifactToken.mockResolvedValue({
      r2Key: "k",
      contentType: "image/png",
      exp: Math.floor(Date.now() / 1000) + 1000,
    });
    r2DirectConfig.mockReturnValue(CFG);

    const res = await handle(ctx("HEAD", URL_WITH_TOKEN));

    expect(res.status).toBe(404); // readArtifact mock → null
    expect(readArtifact).toHaveBeenCalledOnce();
    expect(signGetUrl).not.toHaveBeenCalled();
  });

  it("falls through to the worker path when OFF (GET, no creds)", async () => {
    verifyArtifactToken.mockResolvedValue({
      r2Key: "k",
      contentType: "image/png",
      exp: Math.floor(Date.now() / 1000) + 1000,
    });
    r2DirectConfig.mockReturnValue(null);

    const res = await handle(ctx("GET", URL_WITH_TOKEN));

    expect(res.status).toBe(404);
    expect(readArtifact).toHaveBeenCalledOnce();
    expect(signGetUrl).not.toHaveBeenCalled();
  });

  it("verifies the token BEFORE minting — a bad token never reaches the presigner", async () => {
    verifyArtifactToken.mockResolvedValue(null);
    r2DirectConfig.mockReturnValue(CFG);

    const res = await handle(ctx("GET", URL_WITH_TOKEN));

    expect(res.status).toBe(401);
    expect(signGetUrl).not.toHaveBeenCalled();
    expect(readArtifact).not.toHaveBeenCalled();
  });
});

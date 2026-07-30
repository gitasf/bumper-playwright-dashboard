import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "hono";

/**
 * Download route end-to-end through the real `serveArtifactBytes`
 * (`@/lib/artifacts/serve`), which owns the flag-conditional fork (ADR 0003):
 * direct-R2 ON → verified GET 302s to a presigned R2 URL; HEAD and the OFF
 * state fall through to `readArtifact`. Only IO seams are mocked, so this
 * covers the token gate + the fork's glue — guarding against caching the
 * redirect, routing HEAD into the method-bound presigned URL, and minting
 * before verifying the token. Origin-safety policy on both branches is the
 * companion `artifact-origin-safety.workers.test.ts`.
 */

vi.mock("void", () => ({ defineHandler: (fn: unknown) => fn }));
// The configured separate trace-viewer origin exercises the CORS allow-list
// (`resolveAllowedOrigin`); everything else reads env keys that stay unset.
vi.mock("void/env", () => ({
  env: { VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: "https://traces.example.com" },
}));

const r2DirectConfig = vi.fn();
vi.mock("@/lib/config", () => ({ r2DirectConfig }));

const verifyArtifactToken = vi.fn();
const ARTIFACT_TOKEN_TTL_SECONDS = 60 * 60;
vi.mock("@/lib/artifacts/tokens", () => ({
  verifyArtifactToken,
  ARTIFACT_TOKEN_TTL_SECONDS,
}));

const signGetUrl = vi.fn();
vi.mock("@/lib/artifacts/presign", () => ({ signGetUrl }));

const readArtifact = vi.fn();
vi.mock("@/lib/artifacts/read", () => ({
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

  it("caps the presigned URL to ARTIFACT_TOKEN_TTL_SECONDS for a long-lived (trace) token", async () => {
    // An 8h trace token must NOT mint an 8h anonymous-read presigned R2 URL —
    // the presign is capped to the standard 1h artifact-token life (the SW
    // re-mints per range read, so a short ceiling doesn't cut the session).
    verifyArtifactToken.mockResolvedValue({
      r2Key: "k",
      contentType: "image/png",
      exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
    });
    r2DirectConfig.mockReturnValue(CFG);

    await handle(ctx("GET", URL_WITH_TOKEN));

    const [, , opts] = signGetUrl.mock.calls[0] as [
      unknown,
      string,
      { expiresIn: number },
    ];
    expect(opts.expiresIn).toBe(ARTIFACT_TOKEN_TTL_SECONDS);
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

  it("echoes the configured separate trace-viewer origin in CORS (bridge fetches cross-origin)", async () => {
    verifyArtifactToken.mockResolvedValue({
      r2Key: "k",
      contentType: "application/zip",
      exp: Math.floor(Date.now() / 1000) + 1000,
    });
    r2DirectConfig.mockReturnValue(CFG);

    const res = await handle(
      ctx("GET", URL_WITH_TOKEN, { Origin: "https://traces.example.com" }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://traces.example.com",
    );
  });

  it("falls back to the dashboard origin for any other cross-origin caller", async () => {
    verifyArtifactToken.mockResolvedValue({
      r2Key: "k",
      contentType: "application/zip",
      exp: Math.floor(Date.now() / 1000) + 1000,
    });
    r2DirectConfig.mockReturnValue(CFG);

    const res = await handle(
      ctx("GET", URL_WITH_TOKEN, { Origin: "https://evil.example.com" }),
    );

    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://dash.example.com",
    );
  });
});

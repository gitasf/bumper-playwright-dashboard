import { describe, expect, it } from "vite-plus/test";
import type { ArtifactRead } from "@/lib/artifacts/store";
import { serveArtifactBytes } from "@/lib/artifacts/serve";
import type { R2DirectConfig } from "@/lib/config";
import { SAFE_CONTENT_TYPES, safeContentType } from "@/lib/content-types";

/**
 * Artifact-serving origin-safety policy: attacker-controlled bytes must never
 * execute/render as HTML/JS on the dashboard origin. Defended in two places
 * that must stay consistent: (1) the `SAFE_CONTENT_TYPES` allowlist
 * (`src/lib/content-types.ts`) and (2) `serveArtifactBytes`
 * (`src/lib/artifacts/serve.ts`) — the sole byte-serving function — which
 * sanitises the token content-type and forces `Content-Disposition:
 * attachment` on both paths it owns: the worker-proxy response and the
 * direct-R2 302 (via presigned `response-content-type` /
 * `response-content-disposition` overrides — ADR 0003).
 *
 * This is the cross-check tying the allowlist to byte-serving in both flag
 * states, so widening/dropping either leg fails loudly (companion to the CSP
 * back-reference on the allowlist doc comment and in `void.json`).
 * `content-types.test.ts` covers the allowlist predicates,
 * `artifact-response.test.ts` the HTTP-protocol math.
 *
 * No live network: proxy branch injects a fake `read`; 302 branch runs the
 * real SigV4 presigner (pure URL math) under fake creds.
 */

// Content-types a browser will execute or render-as-active-content on the
// origin if served inline. None of these may ever enter the allowlist, and the
// serve function must downgrade + force-download every one of them.
const EXECUTABLE_OR_RENDERABLE = [
  "text/html",
  "text/html; charset=utf-8",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "application/x-shockwave-flash",
  "text/xml",
  "application/xml",
];

const SERVE_OPTS = {
  r2Key: "t/team1/p/proj1/runs/r1/tr1/a1/payload.bin",
  method: "GET",
  requestHeaders: new Headers(),
  allowedOrigin: "https://dash.example.com",
  remainingTokenSeconds: 777,
};

// Fake S3-API creds — the presigner is pure URL math, so signing under these
// exercises the real 302 branch end-to-end with no network.
const FAKE_R2_CFG: R2DirectConfig = {
  accountId: "acct123",
  accessKeyId: "AKIAEXAMPLEKEY",
  secretAccessKey: "exampleSecretAccessKeyValue",
  bucket: "artifacts-bucket",
};

const fakeRead = (): ArtifactRead => ({
  body: new ReadableStream(),
  size: 10,
  httpEtag: '"e"',
  httpMetadata: new Headers(),
  rangeRequested: false,
});

/** Drive the worker-proxy branch (direct-R2 OFF) with a fake R2 read. */
async function proxyResponse(tokenContentType: string): Promise<Response> {
  return serveArtifactBytes(
    { ...SERVE_OPTS, tokenContentType, directConfig: null },
    { read: () => Promise.resolve(fakeRead()) },
  );
}

/** Drive the direct-R2 302 branch (flag ON) and return the presigned URL. */
async function redirectLocation(tokenContentType: string): Promise<URL> {
  const res = await serveArtifactBytes({
    ...SERVE_OPTS,
    tokenContentType,
    directConfig: FAKE_R2_CFG,
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

describe("artifact origin-safety policy", () => {
  it("the canonical allowlist contains no executable / renderable type", () => {
    // The allowlist is the single source of truth; sweep it directly so adding
    // a renderable type (e.g. image/svg+xml, text/html) here trips this test.
    for (const ct of SAFE_CONTENT_TYPES) {
      expect(EXECUTABLE_OR_RENDERABLE).not.toContain(ct);
      // Every allowlisted type must round-trip safeContentType() unchanged —
      // it is, by construction, what the download endpoint is allowed to emit.
      expect(safeContentType(ct)).toBe(ct);
    }
  });

  it("proxy branch: downgrades every executable / renderable token type to octet-stream", async () => {
    // Whatever the signed token claims, the served content-type is sanitised
    // against the allowlist before it reaches the wire.
    for (const ct of EXECUTABLE_OR_RENDERABLE) {
      const res = await proxyResponse(ct);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
    }
  });

  it("302 branch: signs the sanitised content-type onto the presigned GET", async () => {
    // The presigned URL's `response-content-type` override is what R2 echoes
    // on the GET, so it must carry the sanitised type — never the token's.
    for (const ct of EXECUTABLE_OR_RENDERABLE) {
      const loc = await redirectLocation(ct);
      expect(loc.searchParams.get("response-content-type")).toBe(
        "application/octet-stream",
      );
    }
  });

  it("forces Content-Disposition: attachment on both branches, regardless of the token type", async () => {
    // Stops a leaked signed URL pasted into the address bar from top-level
    // rendering as HTML/JS on the origin; must hold for safe types too.
    for (const ct of [...EXECUTABLE_OR_RENDERABLE, "image/png", "text/plain"]) {
      const proxied = await proxyResponse(ct);
      expect(
        (proxied.headers.get("content-disposition") ?? "").startsWith(
          "attachment;",
        ),
      ).toBe(true);
      const loc = await redirectLocation(ct);
      expect(
        (loc.searchParams.get("response-content-disposition") ?? "").startsWith(
          "attachment;",
        ),
      ).toBe(true);
    }
  });

  it("never emits an inline disposition for any input on either branch", async () => {
    for (const ct of [...EXECUTABLE_OR_RENDERABLE, "image/png", "video/mp4"]) {
      const proxied = await proxyResponse(ct);
      expect(proxied.headers.get("content-disposition")).not.toContain(
        "inline",
      );
      const loc = await redirectLocation(ct);
      expect(
        loc.searchParams.get("response-content-disposition"),
      ).not.toContain("inline");
    }
  });

  it("caps both request-outliving capabilities to the token's remaining life", async () => {
    // Proxy branch: the shared-cache window (`s-maxage`) — an edge-cached copy
    // must not outlive the `?t=` token that keyed it.
    const proxied = await proxyResponse("image/png");
    expect(proxied.headers.get("cache-control")).toContain("s-maxage=777");
    // 302 branch: the presigned URL's expiry — the R2 capability must not
    // outlive the token that authorized it (NOT the signer's 1h default).
    const loc = await redirectLocation("image/png");
    expect(loc.searchParams.get("X-Amz-Expires")).toBe("777");
  });

  it("302 branch: never caches the redirect and scopes CORS to the resolved origin", async () => {
    const res = await serveArtifactBytes({
      ...SERVE_OPTS,
      tokenContentType: "image/png",
      directConfig: FAKE_R2_CFG,
    });
    expect(res.status).toBe(302);
    // The redirect carries a short-lived presigned capability — never cache it.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://dash.example.com",
    );
    expect(res.headers.get("vary")).toBe("Origin");
  });
});

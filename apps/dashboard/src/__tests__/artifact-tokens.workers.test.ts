import { createHmac } from "node:crypto";

import { describe, it, expect, vi } from "vite-plus/test";

// Deterministic secret so sign/verify share a key without the void runtime.
const TEST_SECRET = "test-secret-at-least-32-characters-long-000";
// Mutable so the viewer-link tests can toggle trace-viewer origin isolation.
const config = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long-000",
  ARTIFACT_TOKEN_SECRET: undefined as string | undefined,
  VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: undefined as string | undefined,
}));
vi.mock("void/env", () => ({ env: config }));

const {
  ARTIFACT_TOKEN_TTL_SECONDS,
  TRACE_TOKEN_TTL_SECONDS,
  artifactDownloadTokenTtlSeconds,
  signArtifactDownloadToken,
  signArtifactToken,
  verifyArtifactToken,
  signedDownloadHref,
  selfHostedTraceViewerUrl,
} = await import("@/lib/artifacts/tokens");

const payload = {
  r2Key: "t/team/p/proj/runs/r/tr/a.png",
  contentType: "image/png",
};

/**
 * Guards the HMAC artifact-download token: a valid token round-trips, a tampered
 * payload or expired token is rejected. This is the capability that gates
 * unauthenticated artifact reads, so its verify path must stay strict.
 */
describe("artifact download tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await signArtifactToken(payload);
    // verify also surfaces `exp` (the direct-R2 path caps the presigned URL to
    // the token's remaining life); the rest of the field set must stay exact.
    expect(await verifyArtifactToken(token)).toEqual({
      ...payload,
      exp: expect.any(Number),
    });
  });

  it("rejects a payload tampered after signing", async () => {
    const token = await signArtifactToken(payload);
    const sig = token.slice(token.indexOf(".") + 1);
    // Re-encode a different r2Key but reuse the original signature.
    const forgedBody = Buffer.from(
      JSON.stringify({
        r2Key: "t/attacker/p/secret/runs/x/tr/leak.bin",
        contentType: "image/png",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    expect(await verifyArtifactToken(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await signArtifactToken(payload, -10);
    expect(await verifyArtifactToken(expired)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyArtifactToken("garbage")).toBeNull();
    expect(await verifyArtifactToken("")).toBeNull();
    expect(await verifyArtifactToken("a.b.c")).toBeNull();
  });
});

describe("artifact download lifetime policy", () => {
  const replayTrace = {
    ...payload,
    r2Key: "t/team/p/proj/runs/r/tr/trace.zip",
    type: "trace",
    name: "trace.zip",
    contentType: "application/zip",
  };

  it("gives only replayable traces the extended lifetime", () => {
    expect(artifactDownloadTokenTtlSeconds(replayTrace)).toBe(
      TRACE_TOKEN_TTL_SECONDS,
    );
    expect(
      artifactDownloadTokenTtlSeconds({
        ...replayTrace,
        type: "screenshot",
        name: "actual.png",
        contentType: "image/png",
      }),
    ).toBe(ARTIFACT_TOKEN_TTL_SECONDS);
    expect(
      artifactDownloadTokenTtlSeconds({
        ...replayTrace,
        contentType: "text/plain",
      }),
    ).toBe(ARTIFACT_TOKEN_TTL_SECONDS);
  });

  it("signs with, and reports, the policy-selected lifetime", async () => {
    const nowSeconds = 1_800_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    try {
      const signed = await signArtifactDownloadToken(replayTrace);
      expect(signed.expiresInSeconds).toBe(TRACE_TOKEN_TTL_SECONDS);
      expect(await verifyArtifactToken(signed.token)).toEqual({
        r2Key: replayTrace.r2Key,
        contentType: replayTrace.contentType,
        exp: nowSeconds + TRACE_TOKEN_TTL_SECONDS,
      });
    } finally {
      dateNow.mockRestore();
    }
  });
});

/**
 * Guards the download-URL shape now owned by `signedDownloadHref` /
 * `selfHostedTraceViewerUrl`. These are the single source of the
 * `/api/artifacts/:id/download?t=<token>` literal and the self-hosted
 * trace-viewer wrap — the call sites route through them, so a shape change
 * here is caught once instead of drifting per caller.
 */
describe("artifact download URL builders", () => {
  it("builds the download href with a URL-encoded token query", () => {
    expect(signedDownloadHref("art_123", "tok+en/with=chars")).toBe(
      "/api/artifacts/art_123/download?t=tok%2Ben%2Fwith%3Dchars",
    );
  });

  // `TRACE_VIEWER_PATH` is Playwright's stock SPA, which frames snapshots with a
  // hardcoded `allow-scripts` sandbox. Trace bytes are attacker-craftable, so
  // that shell only ships on a cookieless viewer origin (pruned at build time by
  // `scripts/vendor-trace-viewer.mjs`) — no link may point at a missing file.
  it("offers no self-hosted viewer link without a configured viewer origin", () => {
    expect(
      selfHostedTraceViewerUrl(
        "https://wrightful.example/api/artifacts/art_123/download?t=tok",
      ),
    ).toBeUndefined();
  });

  it("builds the viewer link on the configured cookieless origin, not the download origin", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "https://traces.example.com";
    try {
      const downloadUrl =
        "https://wrightful.example/api/artifacts/art_123/download?t=tok";
      // Deriving the origin from `downloadUrl` would point the scripted SPA back
      // at the session origin — defeating the isolation this env var buys.
      expect(selfHostedTraceViewerUrl(downloadUrl)).toBe(
        "https://traces.example.com/trace-viewer/index.html?trace=" +
          encodeURIComponent(downloadUrl),
      );
      expect(selfHostedTraceViewerUrl(downloadUrl)).not.toContain(
        "trace.playwright.dev",
      );
    } finally {
      config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = undefined;
    }
  });
});

/**
 * Cross-package contract canary. `packages/e2e/src/e2e-context.ts` forges artifact
 * download tokens by hand (Node `createHmac` + base64url over a
 * `{ r2Key, contentType, exp }` body) rather than scraping them from rendered
 * HTML — there is no compile-time link to the canonical signer. This canary
 * reproduces that exact minting algorithm and round-trips it through the REAL
 * `verifyArtifactToken`, so any change to the token body shape, field set, or
 * HMAC/base64url scheme fails HERE (the dashboard's gated CI) instead of
 * silently in the e2e suite. The e2e clone signs with the dashboard's *resolved*
 * artifact-signing secret (`resolveArtifactTokenSecret`, exercised under the
 * fallback here because the mock leaves `ARTIFACT_TOKEN_SECRET` unset), so the
 * forger can never re-derive a different precedence than the producer. Provision
 * a distinct `ARTIFACT_TOKEN_SECRET` and the producer/forger pair stays aligned
 * because both read the same resolver — see config.test.ts for that rule's unit
 * coverage.
 */
describe("e2e token forging contract", () => {
  function base64url(input: Buffer): string {
    return input
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // Byte-for-byte the algorithm in packages/e2e/src/e2e-context.ts#signArtifactToken.
  function forgeLikeE2e(
    r2Key: string,
    contentType: string,
    ttlSeconds = 60,
  ): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = base64url(
      Buffer.from(JSON.stringify({ r2Key, contentType, exp })),
    );
    const sig = base64url(
      createHmac("sha256", TEST_SECRET).update(body).digest(),
    );
    return `${body}.${sig}`;
  }

  it("verifies a token forged the e2e way", async () => {
    const forged = forgeLikeE2e(payload.r2Key, payload.contentType);
    expect(await verifyArtifactToken(forged)).toEqual({
      ...payload,
      exp: expect.any(Number),
    });
  });

  it("rejects an e2e-forged token signed with the wrong secret", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const body = base64url(
      Buffer.from(
        JSON.stringify({
          r2Key: payload.r2Key,
          contentType: payload.contentType,
          exp,
        }),
      ),
    );
    const sig = base64url(
      createHmac("sha256", "a-different-secret-32-characters-xx")
        .update(body)
        .digest(),
    );
    expect(await verifyArtifactToken(`${body}.${sig}`)).toBeNull();
  });
});

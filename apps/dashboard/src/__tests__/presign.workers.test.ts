import { describe, expect, it } from "vite-plus/test";
import type { R2DirectConfig } from "@/lib/config";
import { signGetUrl, signPutUrl } from "@/lib/artifacts/presign";

/**
 * The SigV4 presigning seam (ADR 0003). We don't assert the exact signature
 * (that's aws4fetch's job and depends on the wall-clock `X-Amz-Date`); we pin
 * the structural contract the routes rely on: the URL targets the R2 S3 endpoint
 * (NOT a custom domain), carries the query-signed `X-Amz-*` params, honors the
 * expiry + response-header overrides on GET, and binds Content-Length +
 * Content-Type into the signed headers on PUT (so R2 enforces the size assertion).
 */

const cfg: R2DirectConfig = {
  accountId: "acct123",
  accessKeyId: "AKIAEXAMPLEKEY",
  secretAccessKey: "exampleSecretAccessKeyValue",
  bucket: "artifacts-bucket",
};

describe("signGetUrl", () => {
  it("signs against the R2 S3 endpoint with the bucket + key path", async () => {
    const url = new URL(
      await signGetUrl(cfg, "t/team/p/proj/runs/r/tr/a/shot.png"),
    );
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(
      "/artifacts-bucket/t/team/p/proj/runs/r/tr/a/shot.png",
    );
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("covers the expiry + response-header overrides", async () => {
    const url = new URL(
      await signGetUrl(cfg, "a/b/file.zip", {
        responseContentType: "application/zip",
        responseContentDisposition: "attachment; filename*=UTF-8''trace.zip",
        expiresIn: 120,
      }),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("response-content-type")).toBe(
      "application/zip",
    );
    expect(url.searchParams.get("response-content-disposition")).toBe(
      "attachment; filename*=UTF-8''trace.zip",
    );
    // Presence only: the params are on the URL. That they're actually COVERED by
    // the signature (vs appended post-sign) is provable only against live R2 —
    // tracked as a manual ON-path check in the worklog.
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("matches aws4fetch's RFC3986 canonical query — no bare + or * (R2 SigV4)", async () => {
    // URLSearchParams serializes space→'+' and '*'→'*', but SigV4 signs them as
    // %20 and %2A; a bare '+'/'*' on the wire ⇒ R2 SignatureDoesNotMatch (403).
    // A real disposition has BOTH (the space and the '*' of filename*=), so a
    // regression here 403s every download/trace-viewer GET.
    const disposition = "attachment; filename*=UTF-8''my file.zip";
    const signed = await signGetUrl(cfg, "a/b.zip", {
      responseContentType: "application/zip",
      responseContentDisposition: disposition,
    });
    const query = signed.slice(signed.indexOf("?"));
    expect(query).not.toMatch(/[+*]/); // no bare '+' or '*' anywhere in the query
    expect(query).toContain("%20");
    expect(query).toContain("%2A");
    // …and it still decodes back to the original value.
    expect(
      new URL(signed).searchParams.get("response-content-disposition"),
    ).toBe(disposition);
  });

  it("percent-encodes key segments while preserving slash separators", async () => {
    // A naive encodeURIComponent of the whole key would escape the slashes and
    // 403 every request; per-segment encoding keeps the S3 path matching the
    // stored key byte-for-byte (space → %20, + → %2B).
    const url = new URL(await signGetUrl(cfg, "a b/c+d/e.png"));
    expect(url.pathname).toBe("/artifacts-bucket/a%20b/c%2Bd/e.png");
  });
});

describe("signPutUrl", () => {
  it("query-signs a PUT, binds Content-Length + Content-Type, honors expiresIn", async () => {
    const signed = await signPutUrl(cfg, "a/b/up.png", {
      contentType: "image/png",
      contentLength: 12345,
      expiresIn: 900,
    });
    const url = new URL(signed);
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/artifacts-bucket/a/b/up.png");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signedHeaders).toContain("host");
    expect(signedHeaders).toContain("content-length");
    expect(signedHeaders).toContain("content-type");
    // Same canonical-query normalization as GET (no bare + or *).
    expect(signed.slice(signed.indexOf("?"))).not.toMatch(/[+*]/);
  });
});

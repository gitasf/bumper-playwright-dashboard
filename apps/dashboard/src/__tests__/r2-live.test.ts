// @vitest-environment node
// Node fetch (undici) — NOT happy-dom, whose browser SOP/CORS would block these
// server-side cross-origin requests to R2 before they're even sent.
import { describe, expect, it } from "vite-plus/test";
import { artifactContentDisposition } from "@/lib/artifacts/store";
import { signGetUrl, signPutUrl } from "@/lib/artifacts/presign";
import type { R2DirectConfig } from "@/lib/config";

/**
 * LIVE R2 signature verification (opt-in; skipped unless R2_LIVE_VERIFY=1).
 *
 * The one thing no unit test / miniflare e2e can do: prove R2 ACCEPTS our
 * presigned signatures. Works with a READ-ONLY S3 token — a valid signature
 * surfaces as 200/404-NoSuchKey (auth passed, key absent); a tampered one as
 * 403-SignatureDoesNotMatch. The CONTROL test pins that distinction so a 404
 * provably means "signature accepted." A full write round-trip needs an
 * Object-Read&Write token (PUT is otherwise AccessDenied, not a sig error).
 *
 * Run (network sandbox off — talks to your bucket only):
 *   set -a; . .context/r2-verify.env; set +a; R2_LIVE_VERIFY=1 \
 *     pnpm --filter @wrightful/dashboard exec vp test run r2-live
 */

const LIVE = process.env.R2_LIVE_VERIFY === "1";

function configFromEnv(): R2DirectConfig {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } =
    process.env;
  if (
    !R2_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET
  ) {
    throw new Error(
      "R2_LIVE_VERIFY=1 but the four R2_* env vars are not all set",
    );
  }
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  };
}

describe.skipIf(!LIVE)("live R2 presign signature verification", () => {
  const cfg = LIVE ? configFromEnv() : (null as unknown as R2DirectConfig);
  const r2Key = "_wrightful-verify/trace-bundle.zip";
  const disposition = artifactContentDisposition(r2Key); // attachment; filename*=… (space + *)

  async function signedGet(): Promise<string> {
    return signGetUrl(cfg, r2Key, {
      responseContentType: "application/zip",
      responseContentDisposition: disposition,
    });
  }

  it("CONTROL: a tampered signature is rejected with 403 SignatureDoesNotMatch", async () => {
    // Proves R2 actually validates the signature here — so a 404 in the other
    // tests genuinely means "signature accepted, key absent", not "404 for all".
    const u = new URL(await signedGet());
    const sig = u.searchParams.get("X-Amz-Signature") ?? "";
    u.searchParams.set(
      "X-Amz-Signature",
      `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`,
    );
    const res = await fetch(u.toString());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("SignatureDoesNotMatch");
  });

  it("R2 ACCEPTS our canonicalized GET signature (the +/* response-content-disposition)", async () => {
    const res = await fetch(await signedGet());
    const text = await res.text();
    expect(text).not.toContain("SignatureDoesNotMatch");
    expect([200, 404]).toContain(res.status); // valid sig; object absent ⇒ 404
  });

  it("documents R2's query canonicalization: it ALSO accepts the raw +/* form", async () => {
    // Reverting canonicalizeSignedQuery (what URLSearchParams emits). R2 turns out
    // to form-decode '+'→space and normalize '*'→%2A on its side, so this is
    // accepted too — i.e. the fix is correctness/portability, not a live-403 fix.
    const fixed = await signedGet();
    const q = fixed.indexOf("?");
    const raw = `${fixed.slice(0, q + 1)}${fixed
      .slice(q + 1)
      .replace(/%20/g, "+")
      .replace(/%2A/g, "*")}`;
    const res = await fetch(raw);
    expect(await res.text()).not.toContain("SignatureDoesNotMatch");
    expect([200, 404]).toContain(res.status);
  });

  it("PUT signature is structurally valid (read-only token ⇒ AccessDenied, NOT SignatureDoesNotMatch)", async () => {
    const url = await signPutUrl(cfg, r2Key, {
      contentType: "application/zip",
      contentLength: 40,
    });
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/zip", "content-length": "40" },
      body: new Uint8Array(40),
    });
    const text = await res.text();
    expect(text).not.toContain("SignatureDoesNotMatch");
    expect([200, 403]).toContain(res.status); // 200 with a write token; 403 AccessDenied read-only
  });
});

import { AwsClient } from "aws4fetch";
import type { R2DirectConfig } from "@/lib/config";

/**
 * SigV4 presigning for the direct-R2 artifact byte path (ADR 0003). The only
 * module that talks to the R2 **S3 API** (vs the `void/storage` R2 *binding*,
 * which cannot presign). Pure URL math over `aws4fetch` — no DB, no `env`, no
 * HTTP types — so the signing rule lives in one unit-testable place and the
 * routes stay request → sign → 302 / PUT-URL.
 *
 * Presigned URLs MUST target the account S3 endpoint
 * (`<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`): Cloudflare does NOT
 * honor SigV4 on custom domains (a branded host would need WAF HMAC + a Pro
 * plan — deferred, see ADR 0003). `aws4fetch` query-signs with
 * `{ aws: { signQuery: true } }`, putting the `X-Amz-*` auth params in the URL.
 */

const S3_SERVICE = "s3";
// R2 ignores the SigV4 region but the signature must be computed against one;
// "auto" is Cloudflare's documented value (also what aws4fetch auto-detects for
// any `*.r2.cloudflarestorage.com` host).
const S3_REGION = "auto";

/** Default presigned-URL lifetime (seconds). Matches the 1-hour artifact token. */
const DEFAULT_TTL_SECONDS = 60 * 60;

export interface SignGetOptions {
  /** Lifetime in seconds (R2 allows 1–604800). Defaults to one hour. */
  expiresIn?: number;
  /**
   * `response-content-type` override — signed into the URL so R2 echoes a
   * sanitized Content-Type on the GET regardless of what's stored on the object.
   */
  responseContentType?: string;
  /**
   * `response-content-disposition` override — forces `attachment` so a leaked
   * link opened as a top-level navigation downloads rather than renders.
   */
  responseContentDisposition?: string;
}

export interface SignPutOptions {
  /** Lifetime in seconds. Defaults to one hour. */
  expiresIn?: number;
  /** Signed `Content-Type` — the uploader must send the same value (else 403). */
  contentType: string;
  /**
   * Signed `Content-Length` — R2 rejects a body whose size differs with a 403,
   * which preserves the Worker's old `Content-Length === sizeBytes` assertion.
   */
  contentLength: number;
}

/**
 * Build the `r2.cloudflarestorage.com` object URL for a key. The R2 key has
 * `/`-separated segments (`buildArtifactR2Key`); each segment is
 * percent-encoded but the separators are kept so the S3 path matches the stored
 * key byte-for-byte.
 */
function objectUrl(cfg: R2DirectConfig, r2Key: string): URL {
  const encodedKey = r2Key.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${encodedKey}`,
  );
}

function clientFor(cfg: R2DirectConfig): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: S3_SERVICE,
    region: S3_REGION,
  });
}

/**
 * Re-encode a signed URL's query so the wire bytes match aws4fetch's SigV4
 * canonical form exactly.
 *
 * aws4fetch signs the canonical query using RFC3986 encoding, but the URL it
 * returns serializes the query via `URLSearchParams` (form-urlencoded) rules.
 * Those two encodings diverge on exactly two characters that can appear in our
 * signed query values: a **space** (`URLSearchParams` → `+`, signed → `%20`) and
 * an **asterisk** (`URLSearchParams` → literal `*`, signed → `%2A`). Both occur
 * on every presigned GET — `response-content-disposition` is
 * `attachment; filename*=…` (a space AND the `*` of `filename*=`).
 *
 * R2 itself was verified (live, 2026-06-22, read-only token) to TOLERATE the raw
 * `+`/`*` form — it form-decodes `+`→space and normalizes `*` on its side, so the
 * un-normalized URL also validates. We emit the canonical form anyway so the wire
 * is byte-identical to what was signed: it's the unambiguously-correct
 * representation and is portable to stricter S3 implementations (and any future
 * R2 change) that do NOT form-decode `+`. It is verified-accepted by R2, so this
 * is pure defense-in-depth, not a workaround for a live failure.
 *
 * No other char can diverge here: `safeKeySegment` restricts the filename to
 * `[A-Za-z0-9._-]` and content-types come from a fixed allowlist, so `~` (the
 * only other `URLSearchParams`-vs-RFC3986 divergence) can never appear. We touch
 * only the query substring (never the signed path), and a literal `+`/`*` in a
 * value would itself serialize as `%2B`/`%2A`, so a bare `+`/`*` in the query can
 * only be the space/asterisk we normalize. If a future signed query value can
 * carry other RFC3986-reserved chars, re-encode the whole query instead.
 */
function canonicalizeSignedQuery(signedUrl: string): string {
  const q = signedUrl.indexOf("?");
  if (q === -1) return signedUrl;
  const query = signedUrl
    .slice(q + 1)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A");
  return `${signedUrl.slice(0, q + 1)}${query}`;
}

/**
 * Presigned GET URL for an artifact object. Response-header overrides and the
 * expiry are appended to the URL BEFORE signing so they're covered by the
 * signature (aws4fetch folds any pre-existing query params into the canonical
 * request). The browser/trace-viewer fetches this directly — the Worker is off
 * the byte path.
 */
export async function signGetUrl(
  cfg: R2DirectConfig,
  r2Key: string,
  opts: SignGetOptions = {},
): Promise<string> {
  const url = objectUrl(cfg, r2Key);
  url.searchParams.set(
    "X-Amz-Expires",
    String(opts.expiresIn ?? DEFAULT_TTL_SECONDS),
  );
  if (opts.responseContentType) {
    url.searchParams.set("response-content-type", opts.responseContentType);
  }
  if (opts.responseContentDisposition) {
    url.searchParams.set(
      "response-content-disposition",
      opts.responseContentDisposition,
    );
  }
  const signed = await clientFor(cfg).sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return canonicalizeSignedQuery(signed.url);
}

/**
 * Presigned PUT URL for an artifact object. `Content-Length` and `Content-Type`
 * are passed as headers with `allHeaders: true` so aws4fetch includes them in
 * `X-Amz-SignedHeaders` (both are in its UNSIGNABLE_HEADERS set otherwise) —
 * R2 then 403s any upload whose size/type differs from the registered values.
 * Headers are passed in the sign `init` (NOT a `Request`, whose request-guard
 * would strip `Content-Length`) so aws4fetch signs over a standalone `Headers`.
 */
export async function signPutUrl(
  cfg: R2DirectConfig,
  r2Key: string,
  opts: SignPutOptions,
): Promise<string> {
  const url = objectUrl(cfg, r2Key);
  url.searchParams.set(
    "X-Amz-Expires",
    String(opts.expiresIn ?? DEFAULT_TTL_SECONDS),
  );
  const signed = await clientFor(cfg).sign(url.toString(), {
    method: "PUT",
    headers: {
      "content-length": String(opts.contentLength),
      "content-type": opts.contentType,
    },
    aws: { signQuery: true, allHeaders: true },
  });
  return canonicalizeSignedQuery(signed.url);
}

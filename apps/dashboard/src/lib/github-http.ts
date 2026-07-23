import { base64urlEncode, timingSafeEqualHex } from "@/lib/token-crypto";
import { logger } from "void/log";

/**
 * Env-free GitHub HTTP + crypto core (WebCrypto-only, Workers-compatible):
 * the standard REST fetch envelope, the App JWT mint, and the webhook HMAC
 * verify. Deliberately imports NOTHING that reads `void/env` so modules loaded
 * at `void prepare` config time (notably `github-account-mirror.ts`, reached
 * via `auth.ts`) can reuse it. The env-reading App-auth entry points
 * (installation-token exchange, installation lookup) live in `github-app.ts`,
 * which layers on top of this module.
 */

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "wrightful-dashboard";
const REQUEST_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

/** Owner segment of a `"owner/name"` repo string, or null if malformed. PURE. */
export function parseRepoOwner(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const owner = repo.split("/")[0]?.trim();
  return owner ? owner : null;
}

/** Lowercase hex of a byte array. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Strip a PEM envelope and base64-decode the body to DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Mint a short-lived GitHub App JWT (RS256) for App-level API calls. `iat` is
 * back-dated 60s to tolerate clock skew; `exp` is +9min (GitHub caps the App
 * JWT lifetime at 10 minutes). `privateKeyPem` must be PKCS#8 (see env.ts).
 */
export async function mintAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number,
): Promise<string> {
  const header = base64urlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const payload = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        iat: nowSeconds - 60,
        exp: nowSeconds + 540,
        iss: appId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** Fetch against the GitHub API with the standard App headers + a timeout. */
export async function githubFetch(
  path: string,
  init: RequestInit,
  bearer: string,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${bearer}`,
      "User-Agent": USER_AGENT,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Best-effort, per-colo deduplication for GitHub webhook delivery ids. */
const WEBHOOK_DEDUP_CACHE = "github-webhook-deliveries";
const WEBHOOK_DEDUP_TTL_SECONDS = 3600;

function deliveryCacheKey(deliveryId: string): Request {
  return new Request(
    `https://github-webhook.invalid/delivery/${encodeURIComponent(deliveryId)}`,
  );
}

export async function isReplayedDelivery(
  deliveryId: string | null | undefined,
): Promise<boolean> {
  if (!deliveryId) return false;
  const cacheApi = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheApi) return false;
  try {
    const cache = await cacheApi.open(WEBHOOK_DEDUP_CACHE);
    return Boolean(await cache.match(deliveryCacheKey(deliveryId)));
  } catch (err) {
    logger.warn("github webhook replay cache read failed", {
      deliveryId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function markDeliveryProcessed(
  deliveryId: string | null | undefined,
): Promise<void> {
  if (!deliveryId) return;
  const cacheApi = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheApi) return;
  try {
    const cache = await cacheApi.open(WEBHOOK_DEDUP_CACHE);
    await cache.put(
      deliveryCacheKey(deliveryId),
      new Response("1", {
        headers: { "Cache-Control": `max-age=${WEBHOOK_DEDUP_TTL_SECONDS}` },
      }),
    );
  } catch (err) {
    logger.warn("github webhook replay cache write failed", {
      deliveryId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Run a webhook mutation once, marking the delivery only after it succeeds. */
export async function processWebhookDelivery(
  deliveryId: string | null | undefined,
  process: () => Promise<void>,
): Promise<{ replay: boolean }> {
  if (await isReplayedDelivery(deliveryId)) return { replay: true };
  await process();
  await markDeliveryProcessed(deliveryId);
  return { replay: false };
}

/**
 * Verify a GitHub webhook's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body
 * keyed by the webhook secret). Constant-time compare. Returns false on a
 * missing/malformed header so an unsigned request is simply rejected.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return timingSafeEqualHex(bytesToHex(new Uint8Array(mac)), provided);
}

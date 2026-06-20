import type { Context } from "hono";
import { db, and, eq } from "void/db";
import { apiKeys, type ApiKey } from "@schema";
import { logger } from "void/log";
import { sha256Hex, timingSafeEqualHex } from "@/lib/token-crypto";

/**
 * The pure security decision behind {@link validateApiKey}: given the rows
 * sharing a prefix and the raw key, hash the raw key, constant-time compare it
 * against every candidate's stored hash, and reject a matched-but-revoked row.
 * Returns the matching live row or null.
 *
 * IO-free (async only because {@link sha256Hex} uses `crypto.subtle`) so the
 * branch logic — multiple same-prefix candidates, revoked gate, no match — is
 * unit-testable without a Hono Context or live D1.
 */
export async function selectMatchingKey(
  candidates: ApiKey[],
  rawKey: string,
): Promise<ApiKey | null> {
  const hash = await sha256Hex(rawKey);
  const key = candidates.find((k) => timingSafeEqualHex(k.keyHash, hash));
  if (!key) return null;
  if (key.revokedAt) return null;
  return key;
}

/**
 * Resolve a Bearer API key to the owning row. Returns null on any failure
 * (no header, malformed, no row, hash mismatch, revoked). Constant-time
 * hash compare across all keys sharing the 8-char prefix.
 *
 * Thin IO wrapper: parse the Bearer header, fetch candidates by prefix, and
 * delegate the hash/compare/revoke decision to {@link selectMatchingKey}.
 *
 * Side-effect: bumps `lastUsedAt` after a successful match. Off the
 * auth-path latency budget via `executionCtx.waitUntil` — workerd keeps the
 * promise alive past the response, but doesn't make the caller wait.
 */
export async function validateApiKey(
  c: Context,
  authHeader: string | null | undefined,
): Promise<ApiKey | null> {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const rawKey = match[1];
  const prefix = rawKey.slice(0, 8);

  const candidates = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix));

  const key = await selectMatchingKey(candidates, rawKey);
  if (!key) return null;

  c.executionCtx.waitUntil(
    db
      .update(apiKeys)
      .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(apiKeys.id, key.id)))
      // A bump failure must not fail auth, but route it through the platform
      // logger so persistent write contention is visible in Cloudflare Tail.
      .catch((err: unknown) => {
        logger.warn("api-key lastUsedAt bump failed", {
          keyId: key.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
  );

  return key;
}

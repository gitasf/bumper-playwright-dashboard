import { ulid } from "ulid";
import { and, db, eq, inArray, like, lt } from "void/db";
import { apiKeys } from "@schema";
import { mintToken, sha256Hex } from "@/lib/token-crypto";

/**
 * Mint a fresh project-scoped ingest API key for a synthetic-monitor container
 * run. DB-bound (`void/db`) — integration-only, no unit test.
 *
 * Reuses the standard `apiKeys` storage + `mintToken` / `sha256Hex` crypto from
 * `@/lib/api-key`, so a synthetic key authenticates through the exact same
 * Bearer path as a CI reporter key (no special-casing in `validateApiKey`). We
 * store only the hash + prefix like every other key — which is precisely why
 * the executor MINTS A FRESH key per execution rather than looking one up: the
 * plaintext can't be recovered from the hash to hand to the container, so a
 * reusable stored key would have no retrievable secret. A per-run key is also
 * the tighter blast radius — it is the only credential that ever leaves the
 * Worker into the container, and it is revoked immediately after the run.
 *
 * The label is stamped with the execution id (`synthetic-monitor:<execId>`) so
 * the keys list is self-explanatory and an orphaned key (executor crashed
 * before revoke) is traceable to its execution.
 */
export interface SyntheticKey {
  id: string;
  token: string;
}

/** Label prefix for synthetic-monitor keys — see {@link mintSyntheticKey}. */
export const SYNTHETIC_KEY_LABEL_PREFIX = "synthetic-monitor:";

export async function mintSyntheticKey(
  projectId: string,
  executionId: string,
  now: number,
): Promise<SyntheticKey> {
  const token = mintToken(24, "wrf_");
  const id = ulid();
  await db.insert(apiKeys).values({
    id,
    projectId,
    label: `${SYNTHETIC_KEY_LABEL_PREFIX}${executionId}`,
    keyHash: await sha256Hex(token),
    keyPrefix: token.slice(0, 8),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  });
  return { id, token };
}

/**
 * Delete a synthetic key once its container run is done — cleanup so the per-run
 * credential can't be replayed after the check finishes. We HARD-delete rather
 * than soft-revoke: a synthetic key is single-use and carries no audit value, so
 * keeping the row would grow `apiKeys` by one (revoked) row per execution
 * forever. Scoped by the key's own id (just minted in this project); failures
 * are swallowed by the caller (a lingering key is a tolerable leak, not a reason
 * to fail the recorded execution). `now` is accepted for signature symmetry with
 * the mint path and future audit hooks.
 */
export async function revokeSyntheticKey(
  keyId: string,
  _now: number,
): Promise<void> {
  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
}

/**
 * Sweeper backstop for ORPHANED synthetic keys. {@link revokeSyntheticKey} runs
 * in the executor's `finally`, but it is best-effort — a Worker eviction / CPU
 * kill mid-run skips it — and `validateApiKey` only rejects on `revokedAt` (no
 * time-based expiry is consulted), so an orphaned synthetic key would otherwise
 * remain a permanently-valid project-scoped Bearer credential with no backstop.
 *
 * This cron-driven sweep hard-deletes any `synthetic-monitor:*` key older than
 * `cutoffSeconds`. The caller sets the cutoff to the execution-stale window, so
 * a key still in use by a running (not-yet-reaped) execution is never deleted —
 * by the time a key is that old, its execution has completed (key already
 * revoked) or been reaped. A bounded `.limit` slice keeps a mass-orphan event
 * from blowing the cron budget; the backlog drains across ticks (deleted keys
 * drop out of the next scan). The label prefix is a fixed literal (no LIKE
 * metacharacters), so the prefix match is exact.
 */
export async function sweepStaleSyntheticKeys(opts: {
  cutoffSeconds: number;
  limit: number;
}): Promise<{ deleted: number }> {
  const stale = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        like(apiKeys.label, `${SYNTHETIC_KEY_LABEL_PREFIX}%`),
        lt(apiKeys.createdAt, opts.cutoffSeconds),
      ),
    )
    .limit(opts.limit);
  if (stale.length === 0) return { deleted: 0 };

  await db.delete(apiKeys).where(
    inArray(
      apiKeys.id,
      stale.map((k) => k.id),
    ),
  );
  return { deleted: stale.length };
}

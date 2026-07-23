import { logger } from "void/log";
import { githubFetch } from "@/lib/github-http";

/**
 * The claim/CAS write mechanics shared by both GitHub run surfaces. Each
 * surface stores an external GitHub id (the check-run id on `runs`, the
 * issue-comment id on `githubPrComments`) plus an epoch-seconds claim column
 * CASed on to coordinate concurrent posters, in two flavors:
 *
 * - {@link postWithClaimedSlot} dedupes the FIRST POST of a per-run resource
 *   (the check run): once the id exists, concurrent PATCHes of the same run
 *   are benign because every poster renders the same content.
 * - {@link postWithWriteMutex} serializes EVERY write to a resource shared
 *   across runs (the sticky PR comment), where unserialized PATCHes carrying
 *   different runs' content could land at GitHub in the wrong order.
 *
 * This module owns the ordering; each surface supplies the single-query
 * operations against its own table.
 */

/** Release a held claim, downgrading a release failure to a warning. */
async function releaseClaim(
  surface: string,
  runId: string,
  release: () => Promise<void>,
): Promise<void> {
  await release().catch((releaseErr: unknown) => {
    logger.warn(`github ${surface} claim release failed`, {
      runId,
      message:
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
    });
  });
}

/** One surface's storage operations for {@link postWithClaimedSlot}. */
export interface ClaimedSlotIO {
  /**
   * CAS-claim the POST slot: succeed only while no external id is recorded
   * and the claim column is null or expired. Returns `nowSeconds` as the
   * claim token, or null when the slot is already held.
   */
  claim(nowSeconds: number): Promise<number | null>;
  /** Re-read the external id after losing the claim race. */
  readId(): Promise<number | null>;
  /** Release this caller's claim (CAS on the token, so only if still ours). */
  release(claim: number): Promise<void>;
  /**
   * Persist the posted id. `claim` is non-null iff this caller holds the
   * slot — the write must CAS on it so a slow winner can't clobber newer
   * state. `existingId` is the id that was PATCHed (null on a fresh POST),
   * letting a surface skip a no-op write.
   */
  persist(
    id: number,
    claim: number | null,
    existingId: number | null,
  ): Promise<void>;
}

/**
 * Run one surface's claim → POST/PATCH → persist sequence. With `initialId`
 * already known the surface PATCHes directly (no claim). Otherwise it claims
 * first; on a lost race it re-reads and PATCHes the winner's id if that has
 * landed, else returns (the winner's in-flight POST covers this completion).
 * A `post` failure releases a held claim — so a retry isn't blocked for the
 * claim TTL — and rethrows into the surface's own error envelope.
 */
export async function postWithClaimedSlot(
  surface: string,
  runId: string,
  initialId: number | null,
  io: ClaimedSlotIO,
  post: (existingId: number | null) => Promise<number | null>,
): Promise<void> {
  let existingId = initialId;
  let claim: number | null = null;
  if (existingId === null) {
    claim = await io.claim(Math.floor(Date.now() / 1000));
    if (claim === null) {
      existingId = await io.readId();
      if (existingId === null) return;
    }
  }

  let postedId: number | null;
  try {
    postedId = await post(existingId);
  } catch (err) {
    if (claim !== null) {
      await releaseClaim(surface, runId, () => io.release(claim));
    }
    throw err;
  }
  if (postedId !== null) {
    await io.persist(postedId, claim, existingId);
  } else if (claim !== null) {
    // GitHub's 2xx response carried no id (never expected, but githubWriteId
    // defends against it) — release, or the slot stays blocked for the TTL.
    logger.warn(`github ${surface} write returned no id`, { runId });
    await releaseClaim(surface, runId, () => io.release(claim));
  }
}

/** One surface's storage operations for {@link postWithWriteMutex}. */
export interface WriteMutexIO {
  /** Read the current external id and the runId that last wrote it. */
  read(): Promise<{ id: number | null; runId: string | null }>;
  /**
   * CAS-claim the write mutex: succeed only while the claim column is null
   * or expired. Returns `nowSeconds` as the claim token, or null when the
   * mutex is already held.
   */
  claim(nowSeconds: number): Promise<number | null>;
  /** Release this caller's claim (CAS on the token, so only if still ours). */
  release(claim: number): Promise<void>;
  /**
   * Persist the written id and this caller's runId, clearing the claim. The
   * write must CAS on `claim` so a holder that stalled past the TTL can't
   * clobber the state a successor persisted.
   */
  persist(id: number, claim: number): Promise<void>;
}

export interface WriteMutexOptions {
  /** Total claim attempts before giving up (first attempt has no delay). */
  attempts?: number;
  /** Wait between attempts while another caller holds the mutex. */
  retryDelayMs?: number;
}

/**
 * Serialize every write to ONE GitHub resource shared across runs (the sticky
 * PR comment): claim the mutex, write, persist the id + runId, release. A
 * caller that loses the claim waits briefly and retries — bounded, so a
 * crashed holder's unexpired claim delays ingest by at most
 * `attempts * retryDelayMs`, not the claim TTL.
 *
 * Serializing ALL writes — not just the first POST — is what makes the
 * surface's ULID-monotonic guard hold at GitHub, not just in the DB: two
 * concurrent runs' PATCHes would otherwise race over the wire and the older
 * body could land last. The runId recorded alongside the id doubles as the
 * guard: a caller that observes a persisted `runId >= its own` returns,
 * because the resource already reflects this run or a newer one (which also
 * dedupes a retried finalize of the same run). If the mutex stays busy
 * through every attempt, give up with a warning — the next completed run
 * refreshes the comment.
 */
export async function postWithWriteMutex(
  surface: string,
  runId: string,
  io: WriteMutexIO,
  post: (existingId: number | null) => Promise<number | null>,
  { attempts = 4, retryDelayMs = 1500 }: WriteMutexOptions = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    const seen = await io.read();
    if (seen.runId !== null && seen.runId >= runId) return;
    const claim = await io.claim(Math.floor(Date.now() / 1000));
    if (claim === null) continue;
    // Re-read under the mutex: another holder may have persisted (and
    // released) between the optimistic read above and our claim landing.
    const held = await io.read();
    if (held.runId !== null && held.runId >= runId) {
      await releaseClaim(surface, runId, () => io.release(claim));
      return;
    }
    let postedId: number | null;
    try {
      postedId = await post(held.id);
    } catch (err) {
      await releaseClaim(surface, runId, () => io.release(claim));
      throw err;
    }
    if (postedId === null) {
      logger.warn(`github ${surface} write returned no id`, { runId });
      await releaseClaim(surface, runId, () => io.release(claim));
      return;
    }
    await io.persist(postedId, claim);
    return;
  }
  logger.warn(`github ${surface} write mutex busy; skipping update`, { runId });
}

/**
 * Write (POST/PATCH) a GitHub resource and return the `id` from its JSON
 * response — the shape both surfaces persist. Throws on a non-2xx response;
 * returns null when the response carries no id. Lives here (not in
 * `@/lib/github-http`) so it goes through the imported `githubFetch` binding
 * the surface tests mock.
 */
export async function githubWriteId(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  token: string,
  label: string,
): Promise<number | null> {
  const response = await githubFetch(
    path,
    { method, body: JSON.stringify(payload) },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub ${label} ${method} failed: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as { id?: number };
  return json.id ?? null;
}

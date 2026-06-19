import { describe, it, expect } from "vite-plus/test";
import type { ApiKey } from "@schema";
import { selectMatchingKey } from "@/lib/api-key";
import { sha256Hex } from "@/lib/token-crypto";

/**
 * Guards the ingest auth gate's pure security decision: hash the raw key,
 * constant-time match it against the same-prefix candidates, and drop a
 * matched-but-revoked row. validateApiKey's IO (Bearer parse, db fetch,
 * lastUsedAt bump) is exercised only by the live e2e; this covers the branch
 * logic that no Context+D1 unit test can reach.
 */

/** Build a candidate row whose stored hash matches `rawKey`. */
async function keyFor(
  rawKey: string,
  overrides: Partial<ApiKey> = {},
): Promise<ApiKey> {
  return {
    id: "k_" + rawKey,
    projectId: "p_1",
    label: rawKey,
    keyHash: await sha256Hex(rawKey),
    keyPrefix: rawKey.slice(0, 8),
    createdAt: 0,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("selectMatchingKey", () => {
  it("matches a single live candidate", async () => {
    const raw = "wrf_live_secret_value";
    const key = await keyFor(raw);
    expect(await selectMatchingKey([key], raw)).toBe(key);
  });

  it("picks the one matching hash among same-prefix candidates", async () => {
    // Two rows share the 8-char prefix "wrf_same" but only one hash matches.
    const target = "wrf_sameAAA_correct";
    const decoy = "wrf_sameBBB_wrong";
    const targetRow = await keyFor(target, { id: "k_target" });
    const decoyRow = await keyFor(decoy, { id: "k_decoy" });
    expect(targetRow.keyPrefix).toBe(decoyRow.keyPrefix);

    expect(await selectMatchingKey([decoyRow, targetRow], target)).toBe(
      targetRow,
    );
  });

  it("returns null when the matched row is revoked", async () => {
    const raw = "wrf_revoked_key";
    const revoked = await keyFor(raw, { revokedAt: 1700000000 });
    expect(await selectMatchingKey([revoked], raw)).toBeNull();
  });

  it("does not fall through to a live decoy when the match is revoked", async () => {
    // A revoked row whose hash matches must reject — not silently match some
    // other live row in the candidate set.
    const raw = "wrf_xxx_revoked";
    const other = "wrf_xxx_otherlive";
    const revoked = await keyFor(raw, { id: "k_revoked", revokedAt: 1 });
    const live = await keyFor(other, { id: "k_live" });
    expect(await selectMatchingKey([revoked, live], raw)).toBeNull();
  });

  it("returns null when no candidate hash matches", async () => {
    const stored = await keyFor("wrf_stored_one");
    expect(
      await selectMatchingKey([stored], "wrf_stored_different"),
    ).toBeNull();
  });

  it("returns null for an empty candidate set", async () => {
    expect(await selectMatchingKey([], "wrf_anything")).toBeNull();
  });
});

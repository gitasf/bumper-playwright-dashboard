import { describe, expect, it, vi } from "vite-plus/test";
import type { ClaimedSlotIO, WriteMutexIO } from "@/lib/github-surface-post";
import {
  postWithClaimedSlot,
  postWithWriteMutex,
} from "@/lib/github-surface-post";

/**
 * Fake-IO coverage for the branches of `@/lib/github-surface-post` the
 * pglite-backed surface tests (`github-checks-claim.test.ts`,
 * `github-pr-comment-claim.test.ts`) can't reach deterministically: the
 * write-mutex give-up after exhausted attempts, the release paths when
 * GitHub's 2xx response carries no id, and the skip-under-mutex re-read.
 * Timings are collapsed via `retryDelayMs: 1`.
 */

interface MutexState {
  id: number | null;
  runId: string | null;
  claimedAt: number | null;
}

function mutexIO(state: MutexState): WriteMutexIO {
  return {
    read: () => Promise.resolve({ id: state.id, runId: state.runId }),
    claim: (nowSeconds) => {
      if (state.claimedAt !== null) return Promise.resolve(null);
      state.claimedAt = nowSeconds;
      return Promise.resolve(nowSeconds);
    },
    release: (claim) => {
      if (state.claimedAt === claim) state.claimedAt = null;
      return Promise.resolve();
    },
    persist: (id, claim) => {
      if (state.claimedAt === claim) {
        state.id = id;
        state.runId = "persisted";
        state.claimedAt = null;
      }
      return Promise.resolve();
    },
  };
}

const OPTS = { attempts: 3, retryDelayMs: 1 };

describe("postWithWriteMutex", () => {
  it("writes under a fresh claim and persists the returned id", async () => {
    const state: MutexState = { id: 41, runId: "run-a", claimedAt: null };
    const post = vi.fn(async (existingId: number | null) =>
      Promise.resolve(existingId ?? 99),
    );

    await postWithWriteMutex("t", "run-b", mutexIO(state), post, OPTS);

    expect(post).toHaveBeenCalledWith(41);
    expect(state).toEqual({ id: 41, runId: "persisted", claimedAt: null });
  });

  it("skips without claiming when a newer runId is already persisted", async () => {
    const state: MutexState = { id: 41, runId: "run-z", claimedAt: null };
    const post = vi.fn();

    await postWithWriteMutex("t", "run-b", mutexIO(state), post, OPTS);

    expect(post).not.toHaveBeenCalled();
    expect(state.claimedAt).toBeNull();
  });

  it("reposts when the same runId is recompleted with a newer aggregate", async () => {
    const state: MutexState = { id: 41, runId: "run-b", claimedAt: null };
    const post = vi.fn(async (existingId: number | null) =>
      Promise.resolve(existingId),
    );

    await postWithWriteMutex("t", "run-b", mutexIO(state), post, OPTS);

    expect(post).toHaveBeenCalledWith(41);
    expect(state.claimedAt).toBeNull();
  });

  it("skips when the same run lands after this caller's initial read", async () => {
    const state: MutexState = { id: null, runId: null, claimedAt: null };
    const io = mutexIO(state);
    vi.spyOn(io, "claim").mockImplementationOnce(() => {
      state.id = 41;
      state.runId = "run-b";
      return Promise.resolve(null);
    });
    const post = vi.fn();

    await postWithWriteMutex("t", "run-b", io, post, OPTS);

    expect(post).not.toHaveBeenCalled();
    expect(state.runId).toBe("run-b");
  });

  it("gives up after the attempt budget when the mutex stays held", async () => {
    const state: MutexState = { id: null, runId: null, claimedAt: 10 };
    const io = mutexIO(state);
    const claim = vi.spyOn(io, "claim");
    const post = vi.fn();

    await postWithWriteMutex("t", "run-b", io, post, OPTS);

    expect(claim).toHaveBeenCalledTimes(OPTS.attempts);
    expect(post).not.toHaveBeenCalled();
    expect(state.claimedAt).toBe(10);
  });

  it("releases the claim and skips persist when the write returns no id", async () => {
    const state: MutexState = { id: null, runId: null, claimedAt: null };
    const post = vi.fn(async () => Promise.resolve(null));

    await postWithWriteMutex("t", "run-b", mutexIO(state), post, OPTS);

    expect(post).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ id: null, runId: null, claimedAt: null });
  });

  it("releases the claim and rethrows when the write throws", async () => {
    const state: MutexState = { id: null, runId: null, claimedAt: null };
    const post = vi.fn(async () => Promise.reject(new Error("boom")));

    await expect(
      postWithWriteMutex("t", "run-b", mutexIO(state), post, OPTS),
    ).rejects.toThrow("boom");
    expect(state.claimedAt).toBeNull();
  });
});

describe("postWithClaimedSlot", () => {
  it("releases a held claim when the write returns no id (so the TTL doesn't block the next poster)", async () => {
    let claimedAt: number | null = null;
    const persist = vi.fn();
    const io: ClaimedSlotIO = {
      claim: (nowSeconds) => {
        claimedAt = nowSeconds;
        return Promise.resolve(nowSeconds);
      },
      readId: () => Promise.resolve(null),
      release: () => {
        claimedAt = null;
        return Promise.resolve();
      },
      persist,
    };

    await postWithClaimedSlot("t", "run-a", null, io, async () =>
      Promise.resolve(null),
    );

    expect(claimedAt).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });
});

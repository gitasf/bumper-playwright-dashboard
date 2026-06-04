import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type MirrorableAccount,
  runGithubAccountMirror,
} from "@/lib/github-account-mirror";

// `runGithubAccountMirror` is the orchestration the two `auth.ts` account
// hooks shared byte-for-byte: chain the default `after` FIRST, only mirror
// `github` accounts, log (never swallow) a capture failure, and never throw
// into the hook. The real network+D1 `captureGithubLogin` can't run under the
// void/db stub, so it's injected here — these tests pin the ordering, guard,
// and failure-handling invariants without real I/O.
//
// `void/log`'s `logger` is mocked so we can assert the warn-on-failure signal
// (CLAUDE.md wants caught errors routed through `logger.*`, not `catch {}`).
const warnSpy = vi.fn();
vi.mock("void/log", () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

afterEach(() => {
  warnSpy.mockClear();
});

const githubAccount: MirrorableAccount = {
  userId: "u_1",
  providerId: "github",
  accessToken: "tok",
};

describe("runGithubAccountMirror", () => {
  it("chains the default `after` BEFORE mirroring (void bookkeeping first)", async () => {
    const order: string[] = [];
    const chainDefault = vi.fn(() => {
      order.push("default");
    });
    const capture = vi.fn(async () => {
      order.push("capture");
    });

    await runGithubAccountMirror(githubAccount, chainDefault, capture);

    expect(order).toEqual(["default", "capture"]);
  });

  it("awaits an async default `after` before capturing", async () => {
    const order: string[] = [];
    const chainDefault = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("default-start");
          resolve();
        }),
    );
    const capture = vi.fn(async () => {
      order.push("capture");
    });

    await runGithubAccountMirror(githubAccount, chainDefault, capture);

    expect(order).toEqual(["default-start", "capture"]);
  });

  it("skips capture for a non-github provider but still chains the default", async () => {
    const chainDefault = vi.fn();
    const capture = vi.fn();

    await runGithubAccountMirror(
      { userId: "u_1", providerId: "credential", accessToken: "tok" },
      chainDefault,
      capture,
    );

    expect(chainDefault).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it("forwards the userId + accessToken to capture for a github provider", async () => {
    const capture = vi.fn(async () => {});

    await runGithubAccountMirror(githubAccount, () => {}, capture);

    expect(capture).toHaveBeenCalledWith("u_1", "tok");
  });

  it("logs a capture failure via logger.warn instead of swallowing it", async () => {
    const capture = vi.fn(async () => {
      throw new Error("github 503");
    });

    await runGithubAccountMirror(githubAccount, () => {}, capture);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = warnSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain("github");
    expect(fields).toMatchObject({ userId: "u_1", message: "github 503" });
  });

  it("never throws into the hook even when capture rejects", async () => {
    const capture = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      runGithubAccountMirror(githubAccount, () => {}, capture),
    ).resolves.toBeUndefined();
  });

  it("does not log when capture succeeds", async () => {
    const capture = vi.fn(async () => {});

    await runGithubAccountMirror(githubAccount, () => {}, capture);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("propagates a default-`after` failure (void bookkeeping errors are not ours to swallow)", async () => {
    const chainDefault = vi.fn(() => {
      throw new Error("void bookkeeping failed");
    });
    const capture = vi.fn();

    await expect(
      runGithubAccountMirror(githubAccount, chainDefault, capture),
    ).rejects.toThrow("void bookkeeping failed");
    // The mirror never runs if the default chain blew up.
    expect(capture).not.toHaveBeenCalled();
  });
});

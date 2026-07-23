import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  userInstallationsInclude,
  verifyUserAdministersInstallation,
} from "@/lib/github-app";

/**
 * H1 regression coverage: the GitHub App setup callback must only link an
 * installation the signed-in user actually administers. The security decision
 * lives in `verifyUserAdministersInstallation` (asks GitHub `GET
 * /user/installations` with the USER's token) + the pure
 * `userInstallationsInclude`; the route (`routes/api/github/setup.ts`) maps its
 * verdict to a leak-safe flash. These tests stub `fetch` (which `githubFetch`
 * calls) to exercise every verdict without a live GitHub App install.
 */

const TOKEN = "gho_user_token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Build the `installations` list shape `/user/installations` returns. */
function installations(ids: number[]): { installations: { id: number }[] } {
  return { installations: ids.map((id) => ({ id })) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("userInstallationsInclude", () => {
  it("is true when the id is in the list", () => {
    expect(userInstallationsInclude([{ id: 1 }, { id: 42 }], 42)).toBe(true);
  });

  it("is false when the id is absent or the list is empty", () => {
    expect(userInstallationsInclude([{ id: 1 }, { id: 2 }], 42)).toBe(false);
    expect(userInstallationsInclude([], 42)).toBe(false);
  });

  it("does not match an installation with a missing id", () => {
    expect(userInstallationsInclude([{}, { id: undefined }], 42)).toBe(false);
  });
});

describe("verifyUserAdministersInstallation", () => {
  it("authorizes when the installation is accessible to the user's token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(installations([7, 42, 99])));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyUserAdministersInstallation(TOKEN, 42)).toBe(
      "authorized",
    );
    // Called GitHub with the USER's token, not an App JWT.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/user/installations");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("DENIES a user who does not administer the installation (the core H1 defense)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(installations([7, 99]))),
    );
    expect(await verifyUserAdministersInstallation(TOKEN, 42)).toBe("denied");
  });

  it("errors (not denies) on a non-OK response, e.g. an expired/invalid user token", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: "Bad credentials" }, 401)),
    );
    expect(await verifyUserAdministersInstallation(TOKEN, 42)).toBe("error");
  });

  it("errors on a network/transport failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await verifyUserAdministersInstallation(TOKEN, 42)).toBe("error");
  });

  it("pages past a full first page to find the installation", async () => {
    const firstPage = installations(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    const secondPage = installations([555]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyUserAdministersInstallation(TOKEN, 555)).toBe(
      "authorized",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
  });

  it("stops at a short page and denies without over-fetching", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(installations([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyUserAdministersInstallation(TOKEN, 42)).toBe("denied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

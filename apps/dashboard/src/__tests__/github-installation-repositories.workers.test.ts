import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchInstallationRepositoriesWithToken } from "@/lib/github-app";

const TOKEN = "ghs_installation_token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchInstallationRepositoriesWithToken", () => {
  it("returns a stable, sorted repository list with visibility metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        total_count: 2,
        repositories: [
          { id: 2, full_name: "acme/web", private: true },
          { id: 1, full_name: "acme/api", private: false },
          { id: null, full_name: "invalid/missing-id" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchInstallationRepositoriesWithToken(TOKEN),
    ).resolves.toEqual({
      repositories: [
        { id: 1, fullName: "acme/api", private: false },
        { id: 2, fullName: "acme/web", private: true },
      ],
      totalCount: 2,
      truncated: false,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/installation/repositories?per_page=100&page=1");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("paginates until GitHub's reported total is loaded", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      full_name: `acme/repo-${String(index + 1).padStart(3, "0")}`,
      private: false,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ total_count: 101, repositories: firstPage }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total_count: 101,
          repositories: [
            { id: 101, full_name: "acme/repo-101", private: false },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchInstallationRepositoriesWithToken(TOKEN);

    expect(result.repositories).toHaveLength(101);
    expect(result.totalCount).toBe(101);
    expect(result.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
  });

  it("fails closed when GitHub rejects the repository listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: "Bad credentials" }, 401)),
    );

    await expect(fetchInstallationRepositoriesWithToken(TOKEN)).rejects.toThrow(
      "GitHub installation repositories failed: 401",
    );
  });
});

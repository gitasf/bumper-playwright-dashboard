import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  buildCommentBody,
  postPrComment,
  shouldPostPrComment,
  type RunSummary,
} from "../pr-comment.js";

const baseSummary: RunSummary = {
  status: "failed",
  durationMs: 73_500,
  passed: 12,
  failed: 2,
  flaky: 1,
  skipped: 0,
  timedout: 0,
  total: 15,
  runUrl: "/t/acme/p/web/runs/r_123",
  dashboardUrl: "https://wrightful.example.com",
  repo: "acme/web",
  prNumber: 42,
  environment: "ci",
  commitSha: "abc1234567",
};

describe("shouldPostPrComment", () => {
  const ghaCi = {
    ciProvider: "github-actions",
    prNumber: 42,
    repo: "acme/web",
  };

  it("returns ok when all preconditions are met", () => {
    const r = shouldPostPrComment(true, ghaCi, { GITHUB_TOKEN: "t" });
    expect(r).toEqual({ ok: true, token: "t" });
  });

  it("prefers WRIGHTFUL_GITHUB_TOKEN over GITHUB_TOKEN", () => {
    const r = shouldPostPrComment(true, ghaCi, {
      GITHUB_TOKEN: "default",
      WRIGHTFUL_GITHUB_TOKEN: "override",
    });
    expect(r).toEqual({ ok: true, token: "override" });
  });

  it("skips when disabled", () => {
    const r = shouldPostPrComment(false, ghaCi, { GITHUB_TOKEN: "t" });
    expect(r.ok).toBe(false);
  });

  it("skips when no CI context", () => {
    const r = shouldPostPrComment(true, null, { GITHUB_TOKEN: "t" });
    expect(r.ok).toBe(false);
  });

  it("skips when provider is not github-actions", () => {
    const r = shouldPostPrComment(
      true,
      { ciProvider: "gitlab-ci", prNumber: 1, repo: "x/y" },
      { GITHUB_TOKEN: "t" },
    );
    expect(r.ok).toBe(false);
  });

  it("skips when no PR number (push event)", () => {
    const r = shouldPostPrComment(
      true,
      { ciProvider: "github-actions", prNumber: null, repo: "acme/web" },
      { GITHUB_TOKEN: "t" },
    );
    expect(r.ok).toBe(false);
  });

  it("skips when no token", () => {
    const r = shouldPostPrComment(true, ghaCi, {});
    expect(r.ok).toBe(false);
  });
});

describe("buildCommentBody", () => {
  it("contains the marker, link, and tallies", () => {
    const body = buildCommentBody(baseSummary);
    expect(body).toContain("<!-- wrightful:pr-comment -->");
    expect(body).toContain(
      "https://wrightful.example.com/t/acme/p/web/runs/r_123",
    );
    expect(body).toContain("| 12 | 2 | 1 | 0 |"); // passed/failed/flaky/skipped row
    expect(body).toContain("1m 14s"); // formatted duration
    expect(body).toContain("`abc1234`"); // short sha
    expect(body).toContain("`ci`"); // environment
  });

  it("collapses failed + timedout into one column", () => {
    const body = buildCommentBody({
      ...baseSummary,
      failed: 1,
      timedout: 3,
    });
    expect(body).toContain("| 12 | 4 | 1 | 0 |");
  });

  it("falls back to the dashboard origin when runUrl is null", () => {
    const body = buildCommentBody({ ...baseSummary, runUrl: null });
    expect(body).toContain("https://wrightful.example.com");
  });

  it("carries a rounded-up seconds remainder into the minutes place", () => {
    // 119_700ms = 119.7s -> naive per-part rounding gives "1m 60s"; rounding
    // to whole seconds first must carry to "2m 0s".
    const body = buildCommentBody({ ...baseSummary, durationMs: 119_700 });
    expect(body).toContain("2m 0s");
    expect(body).not.toContain("1m 60s");
  });
});

describe("postPrComment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("PATCHes the existing comment when the marker is found", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 999, body: "not us, lol" },
        { id: 1234, body: "<!-- wrightful:pr-comment -->\n…" },
      ]),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await postPrComment(baseSummary, "ghp_token");
    expect(result.status).toBe("updated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect(patchUrl).toBe(
      "https://api.github.com/repos/acme/web/issues/comments/1234",
    );
    expect(patchInit.method).toBe("PATCH");
    expect(patchInit.headers.Authorization).toBe("Bearer ghp_token");
  });

  it("POSTs a new comment when no marker is found", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, [{ id: 1, body: "unrelated comment" }]),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 7 }));

    const result = await postPrComment(baseSummary, "ghp_token");
    expect(result.status).toBe("created");
    const [postUrl, postInit] = fetchMock.mock.calls[1];
    expect(postUrl).toBe(
      "https://api.github.com/repos/acme/web/issues/42/comments",
    );
    expect(postInit.method).toBe("POST");
  });

  it("throws when the POST returns a non-2xx (e.g. 403 from fork PRs)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    fetchMock.mockResolvedValueOnce(
      new Response("nope", { status: 403, statusText: "Forbidden" }),
    );

    await expect(postPrComment(baseSummary, "ghp_token")).rejects.toThrow(
      /403/,
    );
  });

  it("posts a new comment when the listing call itself fails", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 7 }));

    const result = await postPrComment(baseSummary, "ghp_token");
    expect(result.status).toBe("created");
  });
});

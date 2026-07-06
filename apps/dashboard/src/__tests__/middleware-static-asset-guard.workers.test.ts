import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Regression guard for the "Settings page 500" outage. Under
 * `run_worker_first: ["/**"]` every `/assets/*.js` fetch runs the middleware
 * stack, so a DB hiccup could 500 static chunks. Two guards prevent it:
 * `01.context.ts` skips the tenant DB query for asset/error-page paths, and
 * `00.errors.ts`'s catch arm no longer rewrites an asset-path throw to /oops.
 */

vi.mock("void", () => ({
  defineMiddleware: (fn: unknown) => fn,
}));
vi.mock("void/log", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("void/env", () => ({ env: {} }));

const getSession = vi.fn();
vi.mock("void/auth", () => ({ getSession: () => getSession() }));

vi.mock("@/lib/config", () => ({ billingEnabled: () => false }));

const resolveTenantBundleForUser = vi.fn();
vi.mock("@/lib/authz", () => ({ resolveTenantBundleForUser }));

vi.mock("@/lib/workspace-cookie", () => ({
  readWorkspaceCookie: () => ({ teamSlug: null, projectSlug: null }),
  setWorkspaceCookie: vi.fn(),
  clearWorkspaceCookie: vi.fn(),
}));

const errorsMiddleware = (await import("../../middleware/00.errors"))
  .default as (c: unknown, next: () => Promise<void>) => Promise<unknown>;
const contextMiddleware = (await import("../../middleware/01.context"))
  .default as (c: unknown, next: () => Promise<void>) => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

// Minimal Hono-context stand-in for the fields each middleware reads.
function errorsCtx(path: string) {
  const rewrite = vi.fn(async () => new Response("oops-html", { status: 200 }));
  return {
    ctx: {
      req: { path },
      res: undefined as Response | undefined,
      error: undefined,
      rewrite,
    },
    rewrite,
  };
}

describe("00.errors static-asset catch-arm guard", () => {
  it("does NOT rewrite an asset-path throw to the HTML /oops page", async () => {
    const { ctx, rewrite } = errorsCtx("/assets/profile-CiyjWGeM.js");
    const res = (await errorsMiddleware(ctx, () => {
      throw new Error("db down");
    })) as Response;

    // The whole bug: a throw while serving JS must not become an HTML 500.
    expect(rewrite).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("delivers a deliberately-thrown Response (e.g. a 404) on an asset path as-is", async () => {
    const { ctx, rewrite } = errorsCtx("/assets/missing-chunk.js");
    const thrown = new Response(null, { status: 404 });
    const res = (await errorsMiddleware(ctx, () => {
      throw thrown;
    })) as Response;

    expect(rewrite).not.toHaveBeenCalled();
    expect(res).toBe(thrown);
    expect(res.status).toBe(404);
  });

  it("control: a throw on a real HTML page IS rewritten to /oops (500 preserved)", async () => {
    const { ctx, rewrite } = errorsCtx("/settings/profile");
    const res = (await errorsMiddleware(ctx, () => {
      throw new Error("db down");
    })) as Response;

    expect(rewrite).toHaveBeenCalledWith("/oops");
    expect(res.status).toBe(500);
  });
});

describe("01.context static-asset / error-page DB short-circuit", () => {
  function ctx(url: string) {
    return {
      req: { url },
      set: vi.fn(),
    };
  }

  it("skips the tenant DB query for an authed /assets/* request", async () => {
    getSession.mockReturnValue({
      user: { id: "u1", email: "a@b.c", name: "A", image: null },
    });
    const c = ctx("http://localhost/assets/profile-CiyjWGeM.js");
    const next = vi.fn(async () => {});

    await contextMiddleware(c, next);

    // The root-cause fix: no Postgres read on the static-chunk hot path.
    expect(resolveTenantBundleForUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    const shared = c.set.mock.calls.find((call) => call[0] === "shared")?.[1];
    expect(shared).toMatchObject({ userTeams: [], selectedTeam: null });
  });

  it("skips the tenant DB query for the /oops error page", async () => {
    getSession.mockReturnValue({
      user: { id: "u1", email: "a@b.c", name: "A", image: null },
    });
    const c = ctx("http://localhost/oops");
    await contextMiddleware(c, async () => {});
    expect(resolveTenantBundleForUser).not.toHaveBeenCalled();
  });

  it("control: STILL resolves the tenant bundle for a real tenant page", async () => {
    getSession.mockReturnValue({
      user: { id: "u1", email: "a@b.c", name: "A", image: null },
    });
    resolveTenantBundleForUser.mockResolvedValue({
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
    });
    const c = ctx("http://localhost/t/acme/p/web");
    await contextMiddleware(c, async () => {});
    expect(resolveTenantBundleForUser).toHaveBeenCalledOnce();
  });
});

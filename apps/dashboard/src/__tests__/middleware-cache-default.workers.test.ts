import { describe, expect, it, vi } from "vite-plus/test";

/**
 * Guard for the Workers Cache default-deny stamp (`middleware/00.cache.ts`).
 * With `cache: { enabled: true }` in wrangler.template.jsonc, Cloudflare
 * heuristically edge-caches responses that carry NO Cache-Control header —
 * and session cookies do not bypass the shared cache. Every response that
 * doesn't set an explicit policy must therefore leave the stack as
 * `private, no-store`, or a cookie-authed tenant page could be served to
 * another visitor.
 */

vi.mock("void", () => ({
  defineMiddleware: (fn: unknown) => fn,
}));

const cacheMiddleware = (await import("../../middleware/00.cache")).default as (
  c: unknown,
  next: () => Promise<void>,
) => Promise<unknown>;

function ctx(res: unknown) {
  return { res } as { res: Response };
}

describe("00.cache default Cache-Control stamp", () => {
  it("stamps `private, no-store` on a response with no Cache-Control", async () => {
    const c = ctx(new Response("tenant page html", { status: 200 }));
    await cacheMiddleware(c, async () => {});
    expect(c.res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("stamps the /oops- and 404-style responses too (404 is heuristically cacheable)", async () => {
    const c = ctx(new Response("not found html", { status: 404 }));
    await cacheMiddleware(c, async () => {});
    expect(c.res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("stamps a Response THROWN past next() (the /api/* control-flow 404 path)", async () => {
    // On /api/* paths 00.errors re-throws control-flow Responses; without the
    // catch, a thrown GET 404 with no Cache-Control could be edge-cached.
    const c = ctx(undefined);
    await cacheMiddleware(c, async () => {
      throw new Response("Not Found", { status: 404 });
    });
    expect(c.res.status).toBe(404);
    expect(c.res.headers.get("cache-control")).toBe("private, no-store");
    expect(await c.res.text()).toBe("Not Found");
  });

  it("delivers a thrown Response with an explicit policy untouched", async () => {
    const c = ctx(undefined);
    await cacheMiddleware(c, async () => {
      throw new Response("no", {
        status: 403,
        headers: { "cache-control": "public, max-age=60" },
      });
    });
    expect(c.res.status).toBe(403);
    expect(c.res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("re-throws a genuine Error (not a Response) unchanged", async () => {
    const c = ctx(undefined);
    const boom = new Error("db exploded");
    await expect(
      cacheMiddleware(c, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("leaves an explicit Cache-Control untouched", async () => {
    const c = ctx(
      new Response("summary json", {
        status: 200,
        headers: { "cache-control": "private, max-age=30" },
      }),
    );
    await cacheMiddleware(c, async () => {});
    expect(c.res.headers.get("cache-control")).toBe("private, max-age=30");
  });

  it("leaves an explicit public policy (artifact/asset opt-in) untouched", async () => {
    const c = ctx(
      new Response("bytes", {
        status: 200,
        headers: {
          "cache-control": "public, max-age=31536000, s-maxage=3600, immutable",
        },
      }),
    );
    await cacheMiddleware(c, async () => {});
    expect(c.res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=3600, immutable",
    );
  });

  it("skips WebSocket upgrade responses (101)", async () => {
    // `new Response(null, { status: 101 })` throws in workerd; the middleware
    // only reads `status` before bailing, so a stub is faithful here.
    const headers = new Headers();
    const set = vi.spyOn(headers, "set");
    const c = ctx({ status: 101, headers });
    await cacheMiddleware(c, async () => {});
    expect(set).not.toHaveBeenCalled();
  });

  it("rebuilds a response whose headers are immutable (fetch pass-through)", async () => {
    // Simulate workerd's immutable-headers guard on responses returned
    // straight from fetch(): `set` throws, iteration still works.
    const inner = new Headers({ "content-type": "text/plain" });
    const immutable = new Proxy(inner, {
      get(target, prop) {
        if (prop === "set") {
          return () => {
            throw new TypeError("Can't modify immutable headers.");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const c = ctx({
      status: 200,
      statusText: "OK",
      body: "proxied body",
      headers: immutable,
    });

    await cacheMiddleware(c, async () => {});

    expect(c.res).toBeInstanceOf(Response);
    expect(c.res.status).toBe(200);
    expect(c.res.headers.get("cache-control")).toBe("private, no-store");
    expect(c.res.headers.get("content-type")).toBe("text/plain");
    expect(await c.res.text()).toBe("proxied body");
  });
});

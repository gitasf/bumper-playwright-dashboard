import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { RATE_LIMITER_BINDING_NAMES } from "@/lib/rate-limit";

/**
 * Config-vs-code drift guard for the Cloudflare rate limiters.
 *
 * Each limiter is encoded in three places that must agree:
 *   1. `wrangler.jsonc#ratelimits[]` — the deploy-time binding + budget.
 *   2. `RATE_LIMITER_BINDING_NAMES` (src/lib/rate-limit.ts) — the runtime
 *      source of truth the `RateLimiterBindingName` union is derived from.
 *   3. the string literals passed at the call sites in
 *      `middleware/03.rate-limit.ts`.
 *
 * The budgets (limits/periods) live ONLY in wrangler.jsonc — deliberately not
 * mirrored into TS, since a second copy would itself drift. So the "auth is
 * the strict limiter, artifact is the loose one" intent — and the binding
 * name↔config pairing — exists today only as adjacency + prose. These tests
 * pin both: a renamed / added / removed limiter, or a reordered budget, fails
 * here instead of silently shipping.
 */

const here = dirname(fileURLToPath(import.meta.url));

function readText(relativeFromAppRoot: string): string {
  return readFileSync(join(here, "../..", relativeFromAppRoot), "utf8");
}

/**
 * Minimal JSONC reader for our own controlled config file: strip `//` line
 * comments and trailing commas, then `JSON.parse`. Safe here because
 * `wrangler.jsonc` contains no `//` or comma-before-`}` sequences inside any
 * string value (asserted indirectly — `JSON.parse` would throw otherwise).
 */
function parseJsonc<T>(text: string): T {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "");
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas) as T;
}

interface RateLimitEntry {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

const wrangler = parseJsonc<{ ratelimits: RateLimitEntry[] }>(
  readText("wrangler.jsonc"),
);

describe("rate-limit config ⇆ code", () => {
  it("declares a wrangler ratelimits entry for every referenced binding name and vice-versa", () => {
    const configured = wrangler.ratelimits.map((r) => r.name).sort();
    const referenced = [...RATE_LIMITER_BINDING_NAMES].sort();
    expect(configured).toEqual(referenced);
  });

  it("references every binding name as a literal in the throttle middleware", () => {
    const middleware = readText("middleware/03.rate-limit.ts");
    for (const name of RATE_LIMITER_BINDING_NAMES) {
      expect(middleware).toContain(`"${name}"`);
    }
  });

  it("orders budgets strict→loose: AUTH < API < ARTIFACT", () => {
    const limitOf = (name: string): number => {
      const entry = wrangler.ratelimits.find((r) => r.name === name);
      if (!entry) throw new Error(`no ratelimits entry for ${name}`);
      return entry.simple.limit;
    };
    const auth = limitOf("AUTH_RATE_LIMITER");
    const api = limitOf("API_RATE_LIMITER");
    const artifact = limitOf("ARTIFACT_RATE_LIMITER");
    expect(auth).toBeLessThan(api);
    expect(api).toBeLessThan(artifact);
  });

  it("gives every limiter a unique namespace_id and a positive period", () => {
    const ids = wrangler.ratelimits.map((r) => r.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of wrangler.ratelimits) {
      expect(r.simple.period).toBeGreaterThan(0);
      expect(r.simple.limit).toBeGreaterThan(0);
    }
  });
});

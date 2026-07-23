import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { RATE_LIMITER_BINDING_NAMES } from "@/lib/rate-limit";

/**
 * Config-vs-code drift guard for the Cloudflare rate limiters.
 *
 * Each limiter is encoded in three places that must agree:
 *   1. `wrangler.template.jsonc#ratelimits[]` — the deploy-time binding +
 *      budget. (We read the COMMITTED template, not the gitignored generated
 *      `wrangler.jsonc`; gen-wrangler.mjs copies `ratelimits` through verbatim,
 *      so the values are byte-identical and the test runs on a clean checkout.)
 *   2. `RATE_LIMITER_BINDING_NAMES` (src/lib/rate-limit.ts) — the runtime
 *      source of truth the `RateLimiterBindingName` union is derived from.
 *   3. the string literals passed at the middleware call sites —
 *      `middleware/03.rate-limit.ts` for the post-auth gates, plus
 *      `middleware/02.api-auth.ts` for the pre-auth ingest IP backstop
 *      (which must run BEFORE the Bearer lookup, hence lives in 02).
 *
 * The budgets (limits/periods) live ONLY in wrangler.template.jsonc —
 * deliberately not mirrored into TS, since a second copy would itself drift. So
 * the "auth is the strict limiter, artifact is the loose one" intent — and the
 * binding name↔config pairing — exists today only as adjacency + prose. These
 * tests pin both: a renamed / added / removed limiter, or a reordered budget, fails
 * here instead of silently shipping.
 */

const here = dirname(fileURLToPath(import.meta.url));

function readText(relativeFromAppRoot: string): string {
  return readFileSync(join(here, "../..", relativeFromAppRoot), "utf8");
}

/**
 * Minimal JSONC reader for our own controlled config file: strip whole-line
 * `//` comments and trailing commas, then `JSON.parse`. Safe here because
 * `wrangler.template.jsonc` keeps every `//` comment on its own line and has no
 * `//` or comma-before-`}` sequences inside any string value (asserted
 * indirectly — `JSON.parse` would throw otherwise). The template's
 * `"__CF_WORKER_NAME__"` placeholder and `// __CF_OWN_ACCOUNT_BINDINGS__`
 * marker are both valid jsonc; this test only reads `ratelimits`.
 */
function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "");
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

interface RateLimitEntry {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

const wrangler = parseJsonc(readText("wrangler.template.jsonc")) as {
  ratelimits: RateLimitEntry[];
};

describe("rate-limit config ⇆ code", () => {
  it("declares a wrangler ratelimits entry for every referenced binding name and vice-versa", () => {
    const configured = wrangler.ratelimits.map((r) => r.name).sort();
    const referenced = [...RATE_LIMITER_BINDING_NAMES].sort();
    expect(configured).toEqual(referenced);
  });

  it("references every binding name as a literal in a gate middleware", () => {
    const gates =
      readText("middleware/03.rate-limit.ts") +
      readText("middleware/02.api-auth.ts");
    for (const name of RATE_LIMITER_BINDING_NAMES) {
      expect(gates).toContain(`"${name}"`);
    }
  });

  it("keeps the session tenant-API gate (isTenantApiRoute) wired in 03", () => {
    // The `/api/t/*` family is cookie-authed (no Bearer key stash) and once
    // fell through 03 entirely — leaving the export/runs CSV cursor walk
    // unthrottled. Its gate must consume the predicate from ingest-routes.ts
    // (single source of truth) rather than a re-inlined regex.
    const gate = readText("middleware/03.rate-limit.ts");
    expect(gate).toContain("isTenantApiRoute");
  });

  it("orders budgets strict→loose: AUTH < API < ARTIFACT < INGEST_IP", () => {
    const limitOf = (name: string): number => {
      const entry = wrangler.ratelimits.find((r) => r.name === name);
      if (!entry) throw new Error(`no ratelimits entry for ${name}`);
      return entry.simple.limit;
    };
    const auth = limitOf("AUTH_RATE_LIMITER");
    const api = limitOf("API_RATE_LIMITER");
    const query = limitOf("QUERY_RATE_LIMITER");
    const artifact = limitOf("ARTIFACT_RATE_LIMITER");
    const ingestIp = limitOf("INGEST_IP_RATE_LIMITER");
    expect(auth).toBeLessThan(api);
    expect(api).toBeLessThan(artifact);
    // The pre-auth IP backstop must stay the loosest gate: it only exists to
    // bound failed-auth abuse, and several keys can share one egress IP.
    expect(artifact).toBeLessThan(ingestIp);
    expect(api).toBeLessThan(ingestIp);
    // The public query/export budget (roadmap 2.5) must be LOOSER than the
    // ingest API budget — a read pull is lower-frequency than streaming ingest
    // and one export may page several times — but still well under the pre-auth
    // IP backstop.
    expect(query).toBeGreaterThan(api);
    expect(query).toBeLessThan(ingestIp);
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

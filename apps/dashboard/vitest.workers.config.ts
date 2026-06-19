import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The workerd test lane. Server-side suites — the code that actually runs in
// workerd in production (db layer, ingest, query building) — run here inside
// the real Workers runtime via miniflare, rather than the Node + happy-dom
// lane in vite.config.ts. A suite opts in via the `*.workers.test.ts` filename
// suffix; the Node lane excludes that same glob, so nothing double-runs.
// Components / client islands (which run in the browser, not workerd) and the
// pglite/disk-bound DB-integration tests deliberately stay on the Node lane.
//
// Uses an INLINE miniflare worker (no `wrangler.configPath`) so it is
// self-contained and CI-safe: it does not depend on the gitignored, generated
// wrangler.jsonc and does not bundle the app worker. The test-mode aliases
// mirror vite.config.ts (voidPlugin is off here too): `void/db` → stub,
// `@schema` → the real schema. `cloudflare:workers` is deliberately NOT
// aliased — pool-workers provides the real module.
const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const schemaPath = fileURLToPath(new URL("./db/schema.ts", import.meta.url));
const voidDbStubPath = fileURLToPath(
  new URL("./src/__tests__/helpers/void-db-stub.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@": srcDir,
      "@schema": schemaPath,
      "void/db": voidDbStubPath,
    },
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-05-22",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["src/**/*.workers.test.{ts,tsx}"],
  },
});

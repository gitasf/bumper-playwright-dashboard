import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Real-DB-in-workerd lane. A smoke test that the PRODUCTION data path —
// node-postgres over a Hyperdrive binding, inside the real Workers runtime —
// loads and connects. (The data seam + result shapes are covered against
// node-postgres in pg-integration.test.ts; this lane only adds the workerd +
// Hyperdrive dimension nothing else exercises.)
//
// Needs a live Postgres; the Hyperdrive binding points miniflare at it. If no
// URL is found the binding is omitted and the test self-skips on the
// `env.HYPERDRIVE` guard, so a no-infra run never breaks. Run via
// `pnpm test:workers:db` — kept out of the default `pnpm test` because it needs
// a database.
function pgUrl(): string | undefined {
  if (process.env.PG_TEST_URL) return process.env.PG_TEST_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const txt = readFileSync(
      fileURLToPath(new URL("./.env.local", import.meta.url)),
      "utf8",
    );
    return txt.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

// node-postgres is bundler-hostile in the pool-workers module runner:
//   1. Its dual ESM/CJS sub-packages (pg-protocol/pg-pool/pg-connection-string)
//      resolve to their `import` (ESM) condition, which the workerd loader runs
//      as CommonJS and dies on — pin each to its `require` (CJS) build.
//   2. pg-cloudflare (pg's `cloudflare:sockets` adapter) gates its real impl
//      behind the `workerd` export condition, falling back to a stub
//      (`dist/empty.js`, no CloudflareSocket); point straight at the real build.
const require = createRequire(import.meta.url);
const pgRequire = createRequire(require.resolve("pg/package.json"));
const pgCjsAliases = {
  "pg-protocol": pgRequire.resolve("pg-protocol"),
  "pg-pool": pgRequire.resolve("pg-pool"),
  "pg-connection-string": pgRequire.resolve("pg-connection-string"),
  "pg-cloudflare": join(
    dirname(pgRequire.resolve("pg-cloudflare/package.json")),
    "dist/index.js",
  ),
};

const url = pgUrl();

export default defineConfig({
  resolve: { alias: { ...pgCjsAliases } },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-05-22",
        compatibilityFlags: ["nodejs_compat"],
        ...(url ? { hyperdrives: { HYPERDRIVE: url } } : {}),
      },
    }),
  ],
  test: {
    include: ["src/**/*.workers-db.test.ts"],
  },
});

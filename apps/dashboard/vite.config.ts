import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";
import { testAlias } from "./vitest.shared";

const cloudflareWorkersStubPath = fileURLToPath(
  new URL(
    "./src/__tests__/helpers/cloudflare-workers-stub.ts",
    import.meta.url,
  ),
);

// `vp test` sets mode to "test"; under test we skip voidPlugin/voidReact so
// the test runner doesn't try to bootstrap the database or wrap tests as
// Workers. Tests run in plain Node (vitest default pool) against the same
// alias map as production.
const isTest = process.env.VITEST === "true" || process.argv.includes("test");

// Build-time internal-RPC secret, baked into the SERVER bundle as the global
// `__WRIGHTFUL_INTERNAL_SECRET__` (see src/realtime/room-server.ts). The
// publisher worker and the room Durable Objects are ONE Cloudflare deployment /
// one bundle, so this single value is identical on both sides — exactly what the
// DO-to-DO room-publish gate needs (it only proves "same deployment"), with zero
// secret to provision and automatic rotation per deploy. Computed once per build
// process, so the worker + DO code agree. Omitted under test — there,
// `resolveInternalSecret` requires an explicit REALTIME_INTERNAL_SECRET and
// THROWS without one (never falls back to BETTER_AUTH_SECRET); callers treat
// that as non-fatal. It's only referenced by server-only modules, so it never
// lands in the client bundle.
const buildInternalSecret = randomBytes(32).toString("base64url");

export default defineConfig({
  // Pin to 5173 and fail fast. WRIGHTFUL_PUBLIC_URL is hard-coded to :5173
  // in env defaults and used for OAuth callbacks — silent fallback to 5174
  // would break GitHub auth and confuse the seed/setup scripts.
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    // Mirror the tsconfig `@/*` alias at runtime so non-`src/` source roots
    // (`middleware/`, `routes/`, `pages/`, `crons/`, root `auth.ts`) can
    // import shared lib helpers via `@/lib/...`. tsconfig paths are
    // typecheck-only; Vite/Void's module resolver needs the alias here.
    alias: isTest
      ? {
          // `testAlias` (shared with the workerd lane in vitest.shared.ts) maps
          // `@`/`@schema`/`void/db` to real files, since tests run without the
          // void plugin (the virtual `@schema` / `void/db` modules aren't
          // materialized). `cloudflare:workers` is a workerd built-in
          // unresolvable in plain Node — alias it (Node-lane-only, not in the
          // shared map) to an empty-`env` stub so modules that read bindings
          // (e.g. `src/lib/email.ts`) import cleanly; tests that exercise a
          // binding `vi.mock("cloudflare:workers")`.
          ...testAlias,
          "cloudflare:workers": cloudflareWorkersStubPath,
        }
      : {
          "@": testAlias["@"],
        },
    // Belt-and-braces: voidReact() already sets this, but pin it here so the
    // worker/SSR + client bundles share a single React copy regardless of
    // plugin ordering.
    dedupe: ["react", "react-dom"],
  },
  // JSX transform + React dedupe are provided by `voidReact()` (which wraps
  // `@vitejs/plugin-react`). Do NOT layer a standalone
  // `@rolldown/plugin-babel` with `reactCompilerPreset()` on top — it runs
  // a redundant babel pass over every file and, when combined with void's
  // worker environment, has produced "Invalid hook call" failures during
  // SSR on heavy pages (see worklog 2026-05-23). If we want the React
  // compiler later, integrate it through voidReact's options instead.
  plugins: isTest
    ? [tailwindcss()]
    : [voidPlugin(), voidReact(), tailwindcss()],
  // Bake the per-build internal-RPC secret into the (server) bundle. Under test
  // we omit it so the resolver's no-secret THROW path is exercised.
  define: isTest
    ? {}
    : {
        __WRIGHTFUL_INTERNAL_SECRET__: JSON.stringify(buildInternalSecret),
      },
  test: {
    environment: "happy-dom",
    // Component tests assert iframe URLs and postMessage plumbing; they never
    // need happy-dom to navigate those child frames. Disabling navigation
    // keeps the trace-viewer bridge/snapshot iframes as usable about:blank
    // windows without issuing dozens of localhost fetches that bury the test
    // result in expected ECONNREFUSED/abort noise.
    environmentOptions: {
      happyDOM: {
        settings: {
          navigation: { disableChildFrameNavigation: true },
        },
      },
    },
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    // Suites tagged `*.workers.test.ts` (workerd lane) and `*.workers-db.test.ts`
    // (real-DB-over-Hyperdrive lane) run in workerd, not here — exclude both so
    // they don't run in Node (where `cloudflare:test` isn't even resolvable).
    exclude: [...configDefaults.exclude, "**/*.workers*.test.{ts,tsx}"],
  },
});

import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import babel from "@rolldown/plugin-babel";
import reactCompiler from "babel-plugin-react-compiler";

// Mirror of @vitejs/plugin-react's reactCompilerPreset, defined inline so we
// don't have to add @vitejs/plugin-react to package.json (which would flip
// rwsdk's hasOwnReactVitePlugin check and force us to wire react() ourselves).
// The two pieces that matter:
//   - applyToEnvironmentHook scopes the babel pass to the client environment
//     only. Running it on SSR/worker collides with Vite's SSR module-runner
//     import-injection ("Identifier '__vite_ssr_import_0__' has already been
//     declared") because the React Compiler emits a hoisted import binding
//     under the same name vite re-binds at runtime.
//   - optimizeDeps.include pulls react/compiler-runtime into the initial
//     pre-bundle so the first request doesn't trigger a re-optimize, which
//     was invalidating the lucide-react bundle hash mid-startup and crashing
//     the dev server on cold-start (see the optimizeDeps comment below).
const reactCompilerPreset = {
  preset: { plugins: [reactCompiler] },
  rolldown: {
    applyToEnvironmentHook: (env: { config: { consumer?: string } }) =>
      env.config.consumer === "client",
    optimizeDeps: { include: ["react/compiler-runtime"] },
  },
};

export default defineConfig({
  // Pin to 5173 and fail fast if it's taken. WRIGHTFUL_PUBLIC_URL (used by
  // Better Auth for OAuth callbacks) is hardcoded to :5173 in wrangler.jsonc,
  // so a silent fallback to 5174 would break auth and confuse tooling that
  // probes the API (e.g. fixture upload during setup:local).
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    babel({
      presets: ["@babel/preset-typescript", reactCompilerPreset],
    }),
    tailwindcss(),
  ],
  // Pre-bundle deps reachable only through `"use client"` islands
  // (run-progress.tsx in particular) and the React Compiler runtime emitted
  // by babel-plugin-react-compiler. Without this, Vite's SSR optimizer
  // misses them on the first pass and re-optimizes once SSR reaches the
  // island; the re-optimize invalidates the lucide-react bundle hash
  // mid-startup and the Cloudflare runner-worker crashes with "There is a
  // new version of the pre-bundle for lucide-react.js" before the dev
  // server is reachable. E2E global setup spawns a fresh dev server every
  // run, so cold-start is the only path it exercises. Scoped to both the
  // top-level (client) and `ssr` configs because the failing optimization
  // happens in the SSR pre-bundle dir (`deps_ssr/`).
  optimizeDeps: {
    include: [
      "rwsdk/use-synced-state/client",
      "lucide-react",
      "react/compiler-runtime",
    ],
  },
  ssr: {
    optimizeDeps: {
      include: ["rwsdk/use-synced-state/client", "lucide-react"],
    },
  },
});

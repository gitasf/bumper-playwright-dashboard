# 2026-05-07 — Fix CI: scope React Compiler to client + clear pre-existing typecheck errors

## What changed

Three follow-ups to land CI green on `main` after `feat(dashboard): enable
React Compiler` (e72935c). The compiler change itself was sound for `vite
build`, but two latent issues blocked CI:

1. The babel pass ran in every Vite environment (worker, ssr, client). On
   the SSR runner that produced
   `SyntaxError: Identifier '__vite_ssr_import_0__' has already been declared`,
   crashing the dev server before it could accept connections. E2E global
   setup spawns a fresh dev server per run, so it tripped on every CI job.
2. `react/compiler-runtime` was discovered by the SSR optimizer mid-startup
   (after the worker had already booted), forcing a re-optimize that
   invalidated the `lucide-react` pre-bundle hash mid-flight and triggered
   the same dev-server crash even when (1) was masked.
3. Two pre-existing TypeScript errors in the dashboard test suite (one
   missing `HTMLInputElement` cast, one untyped `vi.fn` mock) were noted as
   "pre-existing" in the React Compiler worklog but are blocking
   `tsgo --noEmit` in CI.

## Details

### `packages/dashboard/vite.config.mts`

Replaced the bare `babel({ plugins: [reactCompiler] })` invocation with an
inline mirror of `@vitejs/plugin-react`'s `reactCompilerPreset`:

```ts
const reactCompilerPreset = {
  preset: { plugins: [reactCompiler] },
  rolldown: {
    applyToEnvironmentHook: (env) => env.config.consumer === "client",
    optimizeDeps: { include: ["react/compiler-runtime"] },
  },
};

babel({ presets: ["@babel/preset-typescript", reactCompilerPreset] }),
```

`@rolldown/plugin-babel@0.2.3` natively respects `applyToEnvironmentHook` on
`RolldownBabelPreset` items (see `filterPresetArrayWithEnvironment` in its
dist) — when the hook returns `false`, the plugin's `applyToEnvironment`
returns `false` and Vite skips the transform for that environment entirely.
That keeps the React Compiler off the SSR/worker module graph, which is the
root cause of the `__vite_ssr_import_0__` collision: the compiler's hoisted
import bindings clashed with vite's own SSR module-runner injection.

The preset is declared inline rather than imported from `@vitejs/plugin-react`
so we don't have to add it to `package.json` — adding it as a dep would flip
rwsdk's `hasOwnReactVitePlugin` check and force us to wire `react()`
ourselves, which is more surface area than this needs.

The preset's `optimizeDeps.include: ["react/compiler-runtime"]` is collected
into the client environment's `optimizeDeps.include` automatically (via
`@rolldown/plugin-babel`'s `config()` hook). The previous workaround of
manually adding `react/compiler-runtime` to both top-level and `ssr.optimizeDeps.include`
was removed from the SSR side (SSR doesn't run the compiler so it doesn't
need the runtime) and kept implicit on the client side via the preset.

Verified by inspecting build output:

- `dist/client/assets/*.js` — multiple files import `react/compiler-runtime`.
- `dist/worker/assets/*.js` — zero matches for `compiler-runtime` (SSR is
  compiler-free, as intended).

### `packages/dashboard/src/__tests__/components/runs-filter-bar.test.tsx`

`screen.getByLabelText` returns `HTMLElement`; cast to `HTMLInputElement` to
read `.value`. One-line fix, no behavioural change.

### `packages/dashboard/src/__tests__/run-progress-broadcast.test.ts`

The hoisted `setState` mock was declared as `vi.fn(async () => {})`, which
typed `mock.calls` as `[][]`. Six `mock.calls[0][0]` / destructuring sites
then failed `tsgo` with `TS2493: Tuple type '[]' has no element at index '1'`.
Adding the parameter signature `(_state: unknown, _key: string)` propagates
the correct call-tuple type and matches the runtime call shape from
`progress.ts` (`stub.setState(summary, "summary")`).

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 333/333 pass.
- `pnpm --filter @wrightful/dashboard build` — succeeds; client bundles
  import `react/compiler-runtime`, worker bundles do not.
- `pnpm --filter @wrightful/e2e test` — 12/12 pass; dev server boots cleanly
  without the `lucide-react` re-optimize crash.
- `CI=1 pnpm --filter @wrightful/e2e test:dashboard` — 33 pass, 2 flaky
  (auto-retry succeeded), 1 skipped. Matches CI's retry policy
  (`retries: process.env.CI ? 2 : 0`).

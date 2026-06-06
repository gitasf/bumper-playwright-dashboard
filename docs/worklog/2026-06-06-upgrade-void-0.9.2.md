# 2026-06-06 — Upgrade Void 0.8.9 → 0.9.2

## What changed

Bumped the Void framework to its latest release. `void` and `@void/react` were both pinned at `0.8.9` in `apps/dashboard/package.json`; latest on npm is `0.9.2`. Both pins moved to `0.9.2` in lockstep and the lockfile was relocked.

The Vite+ toolchain catalog (`@voidzero-dev/vite-plus-core` / `-test`, pinned at `0.1.22` in `pnpm-workspace.yaml`) was **not** touched — `void@0.9.2` resolved cleanly against it, so no coupled toolchain bump was required.

## Details

| Item                                     | Before   | After                |
| ---------------------------------------- | -------- | -------------------- |
| `void`                                   | `0.8.9`  | `0.9.2`              |
| `@void/react`                            | `0.8.9`  | `0.9.2`              |
| `@voidzero-dev/vite-plus-core` / `-test` | `0.1.22` | `0.1.22` (unchanged) |

`CLAUDE.md` changed only because `void prepare` auto-rewrites its injected-block version stamp (`v0.8.11` → `v0.9.2`); no prose was edited.

No source/code changes were needed — the bump is dependency-only.

## Verification

- `pnpm install` — resolved cleanly; peer-dep warnings (`@visx/*` vs React 19, vitest coverage) are pre-existing, not introduced here.
- `void prepare` — codegen succeeded.
- `pnpm check` — 0 errors (87 pre-existing lint warnings), format + lint + typecheck pass.
- `pnpm test` — dashboard 604/604, reporter 194/194.
- `pnpm --filter @wrightful/dashboard build` — built successfully (validated the Void config builds, the specific risk a prior bad toolchain release had hit).

No public changelog was reachable (npm 403, repo private, no bundled CHANGELOG), so the upgrade was validated empirically via the full check/test/build pipeline rather than release notes.

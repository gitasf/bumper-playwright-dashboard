# 2026-06-23 — Pin Node ≥ 22.18.0 to fix Cloudflare build (vite-plus native binding)

## What changed

Cloudflare builds failed during the root `prepare` script (`vp config`) with:

```
Error: Cannot find native binding ...
cause: Cannot find module '@voidzero-dev/vite-plus-linux-x64-gnu'
       Cannot find module './vite-plus.linux-x64-gnu.node'
```

Added a committed Node version pin (`.nvmrc` = `22.18.0`) at the repo root and in
`apps/dashboard`, and tightened root `package.json` `engines.node` from `>=20`
to `>=22.18.0`.

## Root cause

`vite-plus@0.2.0` ships its compiler as platform-specific native bindings in
`optionalDependencies` (`@voidzero-dev/vite-plus-<platform>`). Every binding
declares `engines: {node: "^22.18.0 || >=24.11.0"}`.

Cloudflare's build environment auto-selected **Node 22.16.0** (the repo had no
`.nvmrc`/`.node-version`, and `engines.node` only required `>=20`). `22.16.0`
does **not** satisfy `^22.18.0 || >=24.11.0`, so pnpm treated the Linux binding
as engine-incompatible and **silently skipped it**. The binding never landed in
`node_modules`, so `vp config` (and any `vp`/`void` invocation) crashed at
binding load.

Local dev/CI on the maintainer's machine (Node 24.17.0) satisfies `>=24.11.0`,
so the darwin binding installs and the failure never reproduces locally — it
only bites on Cloudflare's older default Node.

## Details

| File                          | Change                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.nvmrc` (new)                | `22.18.0` — primary signal for Cloudflare Workers Builds node-version detection                                                                                      |
| `apps/dashboard/.nvmrc` (new) | `22.18.0` — covers the case where the CF build root directory is the app subdir                                                                                      |
| `package.json`                | `engines.node`: `>=20` → `>=22.18.0` — documents the toolchain's real floor and surfaces the mismatch as an engine warning instead of a cryptic native-binding crash |

`22.18.0` is the minimal version that satisfies the binding and stays within the
Node 22 major Cloudflare already auto-selected (guaranteed available on their
image). The maintainer's local Node 24.17.0 also satisfies the constraint.

If the Cloudflare project's configured build root makes `.nvmrc` detection
ambiguous, setting the `NODE_VERSION=22.18.0` build variable in the Cloudflare
build settings is the definitive override.

## Verification

- Confirmed the lockfile already records all 8 platform bindings with correct
  integrity/`engines`/`cpu`/`os`/`libc` — the problem was node-version gating, not
  a missing/incomplete lockfile entry.
- Confirmed local Node `v24.17.0` satisfies the binding `engines`, explaining why
  the failure was Cloudflare-only.
- Static change (version pins + engines floor); next Cloudflare build is the
  end-to-end check.

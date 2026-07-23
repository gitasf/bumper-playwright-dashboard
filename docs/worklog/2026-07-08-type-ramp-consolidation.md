# 2026-07-08 — Type-ramp consolidation (hardcoded px → curated 7-step scale)

## What changed

App code set font sizes **three** different ways: **360** hand-written
`text-[NNpx]` arbitrary values across **~15 distinct sizes**, **35** uses of the
`--text-fs-*` CSS-var scale, and **225** Tailwind `text-xs/sm/base` classes. The
hardcoded px set included visually-indistinguishable **0.5px near-duplicate
pairs** (`11` vs `11.5`, `12` vs `12.5`, `13` vs `13.5`, `14` vs `14.5`) plus
several off-scale sizes, so the "same" label rendered at subtly different sizes
across the app and typography couldn't be tuned centrally.

The `--text-fs-*` scale is now a **curated 7-step ramp**, and every hardcoded
`text-[NNpx]` has been snapped onto it. (Chosen over "extend the scale to match
usage" and "convert exact matches only" — see the AskUserQuestion in the session:
_curate a tight ramp and snap everything_.)

**Sizing note / decision history:** the ramp is **whole-pixel** — token name
equals its rendered px (no more `fs-13` secretly rendering 12.5px). An interim cut
tried keeping the design bundle's original **half-pixel** sizes (10.5/11.5/12.5/…)
to avoid changing on-screen size, but half-pixel font sizes are a smell (subpixel
rounding; misleading token names), so the final call is whole-px, **rounded up**.
This nudges some text up ≤1px vs the pre-change app — an accepted tradeoff.

## The ramp (`src/styles.css`)

| token          | px  | role                                             |
| -------------- | --- | ------------------------------------------------ |
| `--text-fs-11` | 11  | micro: badges, timestamps, uppercase meta labels |
| `--text-fs-12` | 12  | small: dense table cells, secondary text         |
| `--text-fs-13` | 13  | base: body text, most rows                       |
| `--text-fs-14` | 14  | medium: emphasized body, row titles              |
| `--text-fs-18` | 18  | heading: section + card headings                 |
| `--text-fs-22` | 22  | title: page titles                               |
| `--text-fs-26` | 26  | display: KPI / big numbers                       |

Removed the redundant steps that had **0** usages (`fs-15`, `fs-16`, `fs-19`,
`fs-28`, `fs-36`).

## Snap map (hardcoded px → token)

| from px           | → token (px) |
| ----------------- | ------------ |
| 9.5, 10, 10.5, 11 | `fs-11` (11) |
| 11.5, 12          | `fs-12` (12) |
| 12.5, 13          | `fs-13` (13) |
| 13.5, 14, 14.5    | `fs-14` (14) |
| 17, 18            | `fs-18` (18) |
| 22                | `fs-22` (22) |
| 26                | `fs-26` (26) |

Every shift is ≤1.5px. Applied with `perl` exact-string replacement of the
bracketed value.

## Consume via bare `text-NN` utilities, not `text-[length:var(...)]`

The tokens live in the `@theme inline` block, so Tailwind generates real
font-size utilities from them — the same mechanism that produces `text-fg-1` /
`bg-bg-3` from `--color-*`. The codebase had been consuming them the hard way via
the arbitrary-value form `text-[length:var(--text-fs-13)]` (395 occurrences, 0
bare), which were all rewritten to the generated utility.

**Token names dropped the redundant `fs`** (font-size) prefix, too: `text-*` is
already Tailwind's font-size namespace, so `text-fs-13` restated the property
twice. Tokens are now `--text-11 … --text-26` → utilities `text-11 … text-26`
(name = rendered px). Final form:

```
<span className="text-13 text-fg-1">…</span>     // 13px, primary text
```

Verified by building (`vp build`) and grepping the emitted CSS — all seven
`.text-NN{font-size:NNpx}` rules are present with correct values.

## Verification

- `pnpm check:fix` (format + lint) — **0 errors** (120 pre-existing warnings).
- `tsgo --noEmit` — **clean**.
- Residual sweep: **zero** `text-[NNpx]` remain in `src`+`pages`; **zero** refs to
  removed steps (`fs-15/16/19/28/36`).
- The `text-[length:var(--text-fs-N)]` class form already existed in the codebase,
  so Tailwind emits these classes — no new build surface.
- Visual: rendering intentionally shifts by ≤1.5px on affected text; not yet
  eyeballed in a running dashboard (mechanical + type/lint verified).

## Follow-ups

- **Lint guard:** ~~ban `text-[NNpx]` (arbitrary px font-size)~~ — **done** as a
  source-grep test, `src/__tests__/token-conventions.test.ts` (also covers the
  legacy `text-fs-` and `text-[length:var(--text-…)]` forms + the color-token
  guard). See `2026-07-08-token-review-cleanup.md`.
- **Second font syntax remains:** 225 Tailwind `text-xs`(12)/`text-sm`(14)/
  `text-base`(16) usages coexist with the `--text-fs-*` var form. Their px values
  are ramp-consistent, but the two syntaxes are a remaining (lower-priority)
  inconsistency — a future pass could pick one. Not done here because collapsing
  onto Tailwind's named scale lacks a 13px step (the ramp's most-used size) and
  redefining `text-sm`/`text-base` would reflow 225 untouched sites.

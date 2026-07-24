# 2026-07-08 — Design-token review + cleanup (Fable audit follow-through)

## What changed

Ran a design-systems review of `src/styles.css` (a Fable-model subagent, which
compiled probes through the repo's actual Tailwind 4.3.1 rather than eyeballing),
then acted on the high-signal, low-risk findings. Every finding was
independently re-verified before acting — one of them had a correct diagnosis
but a **dangerous** suggested fix (see Shadows).

## Actions taken

| Fix                                                | Files                                                                         | Notes                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`text-accent` invisible-text bug**               | `keys.tsx`, `tests.tsx`, `members.tsx`, `monitors/[monitorId]/index.tsx` (×2) | `--accent` aliases to a neutral surface (`bg-3`), so `text-accent` (converted earlier to the honest-but-wrong `text-bg-3`) rendered near-invisible grey. Repointed the 5 sites to **`text-info`** (the accent blue, oklch 268; proper light 0.5 / dark 0.74 values → readable in both themes).                 |
| **Deleted dead `--radius-r-2..12`**                | `styles.css`                                                                  | Zero usages; worse, `rounded-r-*` collides with Tailwind's physical "round right side" variant, and the names lied (`r-8`=9px but `r-12`=12px). The derived `--radius-sm…4xl` scale (idiomatic, actually used) is the sole winner.                                                                             |
| **Pruned the `--code*` token group**               | `styles.css`                                                                  | Dead (no consumers) and contained a typo — `--code-foreground: var(--code-foreground)` was self-referential (missing the `--color-` prefix). Removed all three (@theme + `:root` + `.dark`).                                                                                                                   |
| **Removed past-tense status aliases**              | `styles.css`, `general.tsx`                                                   | `--passed`/`--failed`(`-soft`) propped up **1** site (`bg-passed`); codemodded it to `bg-pass` and deleted the 12 alias lines. Same one-intent-two-vocabularies smell the color unification cured.                                                                                                             |
| **Shadow cleanup (NOT the audit's suggested fix)** | `styles.css`                                                                  | See below. Deleted the unused `--shadow-sm` / `--shadow-md` (0 consumers); kept `--shadow-lg` (1 consumer: the login auth card) with a load-bearing comment.                                                                                                                                                   |
| **Regression-guard test**                          | `src/__tests__/token-conventions.test.ts` (new)                               | Source-grep test that fails if banned patterns return: hand-written `text-[NNpx]`, legacy `text-fs-`, the `text-[length:var(--text-…)]` form, or the theme-stable semantic color classes in app code (outside `ui/`). 4 tests, green. This is the "lint guard" the color/type worklogs flagged as a follow-up. |

## The shadow finding — why the audit's fix was rejected

The audit flagged (correctly) that the custom `--shadow-sm/md/lg` tokens are dead:
they live in `:root`/`.dark`, **not** `@theme`, so Tailwind's `shadow-*` utilities
render its stock values, not these. Its suggested fix was to **register them into
`@theme`**. That would have been a **regression**: the `ui/` component library
implements elevation via a layered system — low-opacity shadow utilities
(`shadow-xs/5`, `shadow-lg/5`, …) **plus** `before:shadow-[…]` pseudo-element
highlights and `dark:before:shadow-[0_-1px_white/6%]` top-edge lights — which
depends on Tailwind's **default** shadow scale. Registering custom `--shadow-*`
into `@theme` overrides those defaults and changes the shadow on every
card/dialog/popover/input/menu in the app.

Verified consumer counts: `--shadow-sm`/`--shadow-md` → **0**; `--shadow-lg` → **1**
(`login.tsx`, via `shadow-[var(--shadow-lg)]`). So the correct action was the
opposite of "register": delete the two unused tokens, keep `--shadow-lg` as an
explicitly-bespoke auth-card value, and leave a comment warning the next
reader/agent **not** to register these into `@theme`.

## Findings deferred (need design judgment, not deleted)

- **Type-ramp line-heights** — `text-13` sets font-size only; built-in `text-sm`
  also sets line-height, so they differ in kind. Adding `--text-NN--line-height`
  pairs reflows vertical rhythm app-wide → wants a design pass + visual review.
- **`text-xs/sm/base` (~225) vs `text-NN` coexistence** — same px values, two
  spellings; consolidation depends on the line-height decision above.
- **Light-mode `--flaky` amber ≈ 3.6:1** — fails WCAG AA as text at 11–13px. A
  real a11y issue but a color-value change; left for a deliberate contrast pass.
- **Sidebar hardcodes primitive oklch values** instead of `var(--bg-1)` etc.
  (drift risk, not a current bug).
- **`fg-1..4` (1-based) vs `bg-0..3` (0-based) indexing** — real but not worth
  churning hundreds of files; document the convention instead.

## What the audit explicitly cleared as correct (don't "fix")

`@theme inline` is required (a `.dark` override wouldn't propagate through the
`--color-* → --*` hop otherwise — it's the official shadcn v4 pattern); the
two-layer indirection is canonical; the `--muted`/`--input` light/dark divergence,
the `X`/`X-soft` status convention, the monitor→test status aliasing, and the
duplicated odd/even keyframes (a restart-on-retrigger trick) are all intentional.

## Verification

- `vp build` — **succeeds**; emitted CSS confirms `ui/` `shadow-*` still resolve
  to Tailwind defaults (unchanged) and `.text-info{color:var(--info)}` emits.
- No dangling refs to any deleted token (`--radius-r-*`, `--code*`, `--passed`/
  `--failed`, `--shadow-sm/md`) — grep clean.
- `pnpm check:fix` — **0 errors**; `tsgo --noEmit` — **clean**.
- New `token-conventions.test.ts` — **4/4 pass**.

## Note

The `text-info` repoint is a real (intended) visual change — 5 previously-invisible
bits of text become accent-blue. The shadow-token deletions and comment are
zero-visual (dead code). Worth an eyeball on the 5 `text-info` sites + the login
card before shipping.

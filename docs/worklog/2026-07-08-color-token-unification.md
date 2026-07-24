# 2026-07-08 — Color-token vocabulary unification (app code → primitive scale)

## What changed

The dashboard theme defines **two parallel color vocabularies** in
`src/styles.css`: an app-native **primitive scale** (`--bg-0..3`, `--fg-1..4`,
`--line-1..2`) and a **shadcn-style semantic layer** (`--background`, `--card`,
`--popover`, `--foreground`, `--muted`, `--muted-foreground`, `--border`,
`--accent`, …). The semantic layer is (mostly) **aliases onto the primitives**.

App code had drifted into using **both interchangeably** — ~50/50, with 25+
files mixing the two vocabularies in a single file (`text-fg-3` next to
`text-muted-foreground` for the same intent). This was the root cause of the
dark-mode avatar mismatch fixed in `2026-07-08-github-actor-avatars.md`.

**All app code (everything except `src/components/ui/`) is now standardized on
the primitive scale** for every _theme-stable_ token. The `ui/` library keeps
the semantic tokens so it stays compatible with the COSS/shadcn registry
(`npx shadcn@latest add …` emits semantic tokens).

## Why primitive-canonical (and why `ui/` is exempt)

The full alias table (verified against `styles.css` `:root` + `.dark`):

| semantic token                                                             | light    | dark         | theme-stable?        |
| -------------------------------------------------------------------------- | -------- | ------------ | -------------------- |
| `foreground`, `card-foreground`, `popover-foreground`, `accent-foreground` | `fg-1`   | `fg-1`       | ✅                   |
| `muted-foreground`                                                         | `fg-3`   | `fg-3`       | ✅                   |
| `border`                                                                   | `line-1` | `line-1`     | ✅                   |
| `background`                                                               | `bg-0`   | `bg-0`       | ✅                   |
| `card`                                                                     | `bg-1`   | `bg-1`       | ✅                   |
| `popover`                                                                  | `bg-2`   | `bg-2`       | ✅                   |
| `accent`                                                                   | `bg-3`   | `bg-3`       | ✅                   |
| **`muted`**                                                                | `bg-3`   | **`bg-2`**   | ❌ diverges by theme |
| **`input`**                                                                | `line-1` | **`line-2`** | ❌ diverges by theme |

- The **theme-stable** tokens are pure aliases, so swapping them primitive-ward
  is a **guaranteed zero-pixel-change** (identical CSS-var chain in both themes).
- `--muted` and `--input` are **genuinely theme-adaptive** — not redundant.
  They were **left as semantic tokens** (`bg-muted`, `border-input`); collapsing
  them to a single primitive would regress dark mode. That divergence is exactly
  what bit the avatars.
- The primitive scale is a **superset** of the stable semantic tokens and also
  covers `fg-2`/`fg-4`/`line-2`/raw-`bg-3`, which have no semantic names — so
  primitive-canonical loses nothing, whereas semantic-canonical can't express
  those. Hence the direction.

## Codemod (theme-stable swaps applied to app code only)

`text-muted-foreground→text-fg-3`, `{text,bg}-foreground→…-fg-1`,
`text-{card,popover,accent}-foreground→text-fg-1`, `border-border→border-line-1`,
`bg-border→bg-line-1`, `divide-border→divide-line-1`, `bg-background→bg-bg-0`,
`bg-card→bg-bg-1`, `bg-popover→bg-bg-2`, `{bg,text,border}-accent→…-bg-3`,
`text-background→text-bg-0`, `bg-muted-foreground→bg-fg-3`.

Applied with `perl` using negative look-around (`(?<![-\w])TOKEN(?![-\w])`) so
suffix-extended tokens (`accent-soft`, `accent-line`, `*-foreground` families)
and role colors are never touched. **Left untouched (correctly):** `bg-muted`,
`border-input`, `ring-ring`, and all role colors
(`primary`/`secondary`/`destructive`/`success`/`warning`/`info`).

## Known pre-existing bug surfaced (not fixed here)

`--accent` aliases to `bg-3` (a neutral surface), so **`text-accent` renders as
near-invisible grey text in both themes** — yet it's used (paired with the
blue `bg-accent-soft`/`border-accent`) as if it were an accent-_blue_ text
color, which no token provides. Sites: `keys.tsx:320` (link hover),
`tests.tsx:148`, `members.tsx:325`, `monitors/[monitorId]/index.tsx:852,1087`.
The codemod converted these to `text-bg-3` to **preserve current pixels** and
make the mismatch visible instead of hiding it behind a misleading name.
**Fix TBD** — likely wants `text-info` (or a new `--accent-fg` blue token).

## Verification

- `pnpm check:fix` (format + lint) — **0 errors** (120 warnings all pre-existing
  `no-unsafe-type-assertion`, none in changed files).
- `tsgo --noEmit` — **clean**.
- Residual sweep: **zero** theme-stable semantic tokens remain in app code
  (`grep -P '(?<![-\w])(bg|border|text|ring|divide|…)-(border|background|card|popover|accent|foreground|muted-foreground)(?![-\w])'`
  over `src`+`pages` minus `components/ui/` → empty, excluding the intentional
  `accent-soft`/`accent-line`/role/`ring-ring` keeps).
- Rendering is unchanged by construction (each swapped class resolves to the
  identical `--*` value it did before, in both themes).

## Follow-ups

- **Lint guard:** ~~add a rule banning the theme-stable semantic classes in app
  code~~ — **done** as a source-grep test, `src/__tests__/token-conventions.test.ts`
  (see `2026-07-08-token-review-cleanup.md`).
- **Fonts:** the parallel `text-[Npx]` → `--text-fs-*` consolidation is **done** —
  see `2026-07-08-type-ramp-consolidation.md`.
- Resolve the `text-accent`/`bg-accent-soft` accent-blue-text bug above.

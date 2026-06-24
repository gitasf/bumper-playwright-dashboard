# 2026-06-24 — Fix unreadable text on soft (tinted) badge variants

## What changed

The status badges on the test-detail page (and everywhere the `success` / `error` /
`warning` / `info` `Badge` variants are used) had faint, near-invisible text. The
"PASSED" / "FAILED" / "FLAKY" / tag badges rendered as a coloured tint with text
that was effectively the same colour as the badge background.

Root cause was a mismatched text token in `ui/badge.tsx`. The four soft variants
pair a _faint_ tinted background (`bg-{color}/8` light, `bg-{color}/16` dark) with
`text-{color}-foreground`. But the `--*-foreground` tokens are the **on-solid-colour
contrast** colours — near-white in light mode, near-black in dark mode — intended to
sit on a _solid_ `bg-destructive`-style fill (e.g. the destructive button), not on an
8–16% tint. The result:

- **Light mode:** near-white text (`oklch(0.99 …)`) on a near-white tint → invisible
  (PASSED, FAILED, info tags).
- **Dark mode:** near-black text (`oklch(0.135 …)`) on a dark tint → invisible (all of
  them, including the otherwise-readable-in-light warning variant).

The fix swaps the text token to the saturated colour itself (`text-{color}`), the
standard soft-badge pairing. Because the colour tokens are redefined per theme in
`styles.css`, `text-destructive` etc. automatically pick the bright dark-mode shade
and the saturated light-mode shade — no `dark:` override needed.

## Details

`apps/dashboard/src/components/ui/badge.tsx` — `badgeVariants` cva:

| variant   | before                                                                | after                                                      |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `error`   | `bg-destructive/8 text-destructive-foreground dark:bg-destructive/16` | `bg-destructive/8 text-destructive dark:bg-destructive/16` |
| `info`    | `bg-info/8 text-info-foreground dark:bg-info/16`                      | `bg-info/8 text-info dark:bg-info/16`                      |
| `success` | `bg-success/8 text-success-foreground dark:bg-success/16`             | `bg-success/8 text-success dark:bg-success/16`             |
| `warning` | `bg-warning/8 text-warning-foreground dark:bg-warning/16`             | `bg-warning/8 text-warning dark:bg-warning/16`             |

`outline`, `secondary`, `default`, `destructive` variants are unchanged (they use
solid backgrounds with their correct contrast foregrounds).

## Scope / blast radius

- Swept every usage of `variant="success|error|warning|info"` across `apps/` +
  `packages/` and every direct `badgeVariants()` call. The `Badge` usages
  (`StatusBadge`, billing Pro/Trial chips, diff "warning" chip, test-detail tags +
  status, visual-diff "error" chip) all render on the normal page/card/dialog
  background — so saturated text on a faint tint is the correct, readable pairing in
  every case; none sit on a solid colour fill that would break.
- The `Alert` component shares those variant _names_ but is a **separate, already-correct**
  cva (`ui/alert.tsx`): faint bg + coloured icon only, body text stays
  `text-card-foreground` / `text-muted-foreground`. Untouched.
- The `--*-foreground` tokens remain defined in `styles.css` (still used by the solid
  `destructive` button etc.); left in place.

## Verification

- `pnpm check` (vp check — format + lint + type-check): **0 errors**, 606 files. The
  120 warnings are pre-existing `no-unsafe-type-assertion` lint warnings in unrelated
  e2e fixtures.
- Reasoned through both-theme contrast from the actual `styles.css` oklch token values:
  light-mode saturated text (`L≈0.5–0.62`) on a near-white tint and dark-mode bright
  text (`L≈0.7–0.82`) on a dark tint are both legible — a dramatic improvement over the
  prior same-colour-as-background text.

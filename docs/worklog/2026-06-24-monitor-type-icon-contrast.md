# 2026-06-24 — Fix unreadable "new monitor" type-chooser icons (text-accent → text-info)

## What changed

On the **New monitor** page, the three type-chooser cards (Browser check / Uptime
check / TCP check) each show a glyph in a rounded chip. The glyphs looked identical
and faded into the chip background. Same symptom on the **monitors empty state** icon
one screen earlier.

The glyphs themselves are _not_ identical in code — `MonTypeGlyph` draws a distinct
beaker (browser), globe (http), and plug (tcp). The problem was purely colour: the
chip used `text-accent`, and in this theme

```css
--accent: var(
  --bg-3
); /* light oklch(0.95 …) — near-white | dark oklch(0.235 …) — dark gray */
```

`--accent` is aliased to `--bg-3` — the shadcn "subtle hover/active background"
convention, **not** a vivid foreground accent. So the icons rendered in a
background-tier gray sitting on the `bg-bg-2` chip: light-gray-on-lighter-gray (and
dark-on-darker in dark mode). Near-zero contrast meant the distinct shapes were
invisible, so they read as identical blobs fading into the card.

The design's actual vivid accent is the indigo family — `--accent-soft` /
`--accent-line` are both built from `oklch(0.5 0.16 268)`, the same base as `--info`,
and info badges/tags/toasts all use `text-info`. The fix colours the icons with
`text-info`, which has strong contrast on the `bg-bg-2` chip in both themes.

## Details

| file                                                                             | line      | before                  | after                 |
| -------------------------------------------------------------------------------- | --------- | ----------------------- | --------------------- |
| `pages/t/[teamSlug]/p/[projectSlug]/monitors/[monitorId]/index.tsx` (`TypeCard`) | icon chip | `… bg-bg-2 text-accent` | `… bg-bg-2 text-info` |
| `pages/t/[teamSlug]/p/[projectSlug]/monitors/index.tsx` (`MonitorsEmpty`)        | icon chip | `… bg-bg-2 text-accent` | `… bg-bg-2 text-info` |

Only the two icon-chip instances were changed. The other `text-accent` usages
(`keys.tsx` link `hover:text-accent`; the assertion-comparison `<span>`s at
`[monitorId]/index.tsx` ~838/1073) are different contexts, were not reported, and are
left as-is — though `hover:text-accent` fading a link toward the background is a likely
latent low-contrast issue worth a separate look.

## Verification

- `pnpm check` (vp check — format + lint + type-check): **0 errors**, 606 files (120
  pre-existing unrelated warnings).
- Contrast reasoned from `styles.css` oklch values: `text-info` is `oklch(0.5 0.16 268)`
  (light) / `oklch(0.74 0.1 268)` (dark) on a `bg-bg-2` chip (`oklch(0.975)` /
  `oklch(0.195)`) — strong contrast both themes; the beaker/globe/plug shapes are now
  clearly distinct.

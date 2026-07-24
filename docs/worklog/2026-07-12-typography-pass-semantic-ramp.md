# 2026-07-12 — Typography pass + semantic type-ramp rename

## What changed

Two related pieces of work from a `/better-typography` review of the whole
dashboard, plus a follow-up decision:

1. **Typography fixes** — the review found the foundation already strong
   (variable `.woff2` fonts, curated ramp with baked tracking, `tabular-nums`
   coverage) and fixed the gaps it did find.
2. **Semantic ramp rename** — the 7-step type ramp's px-literal token names
   (`text-11` … `text-26`) were renamed to role names (`text-micro` …
   `text-display`). Decision context: px names are self-verifying but encode
   no intent and lie if a step's value ever changes; Tailwind's ordinal names
   (`text-2xl`) hide the value _and_ the role. Role names encode intent and
   survive a rescale. The roles were already documented as comments on each
   token — this promotes them into the names.

## The ramp, renamed

| Old       | New            | Value                 | Role                                        |
| --------- | -------------- | --------------------- | ------------------------------------------- |
| `text-11` | `text-micro`   | 11px                  | badges, timestamps, uppercase meta labels   |
| `text-12` | `text-caption` | 12px                  | table headers, micro-labels, secondary text |
| `text-13` | `text-body`    | 0.8125rem (13px)      | body text, most rows                        |
| `text-14` | `text-body-lg` | 0.875rem (14px)       | emphasized body, row titles                 |
| `text-18` | `text-heading` | 18px, −0.2px tracking | section + card headings                     |
| `text-22` | `text-title`   | 22px, −0.3px tracking | page titles                                 |
| `text-26` | `text-display` | 26px, −0.4px tracking | KPI / big numbers                           |

Mechanics of the rename (the non-obvious parts):

- **`src/lib/cn.ts`** — tailwind-merge classifies unknown `text-*` classes as
  colors and silently drops them when merged with e.g. `text-fg-1`. The
  `font-size` classGroup registration was updated to the new names; the ramp
  comment in `styles.css` now points at this file so a future step can't be
  added without registering it.
- **`src/__tests__/token-conventions.test.ts`** — added a guard banning the
  legacy numeric names (`/(?<![-\w])text-(11|12|13|14|18|22|26)(?![-\w])/`),
  mirroring the existing `text-fs-*` legacy guard, so the old vocabulary
  can't re-accrete.
- Root `CLAUDE.md` micro-label convention updated (`text-[12px]` →
  `text-caption`). Older worklogs keep the numeric names — historical record.
- ~400 usages renamed across `pages/`, `src/` (including `ui/` files that had
  adopted ramp tokens), `routes/`, `middleware/` — plain sed, verified zero
  remaining numeric-name matches.

## Typography fixes (from the review)

- **Off-ramp heading sizes** — 16 headings (auth/invite/picker/error pages)
  used Tailwind's stock `text-2xl` (24px, off-ramp, inconsistent ad-hoc
  `tracking-tight`); `pages/oauth/consent.tsx` used `text-lg`. All snapped to
  the ramp (`text-title` / `text-heading`), matching the in-app page titles.
- **`styles.css` body** — added `-moz-osx-font-smoothing: grayscale`
  (macOS Firefox parity with the existing `-webkit-font-smoothing`) and
  `font-synthesis: style`. Both variable fonts cover wght 100–900, so a
  synthesized bold only appears when a font file fails to load — now that
  failure is visible. `style` stays allowed deliberately: **Geist ships no
  italic**, so `.ansi-italic` (Playwright SGR output) and the `italic`
  placeholder spans rely on synthesized oblique.
- **iOS input zoom** — `SearchFilterInput` (`text-13` fixed) and the combobox
  filter search in `filter-controls.tsx` (`text-sm` fixed) zoomed the page on
  focus on iOS (<16px). Now `text-base sm:text-body` / `text-base sm:text-sm`,
  matching the `ui/input`/`textarea`/`select` pattern.
- **Underline offsets** — bare `underline` links (run-tests popover, run
  history retry, signup, team picker) given `underline-offset-2`/`-4` to match
  the tuned idiom used elsewhere (login, breadcrumbs).
- **Deliberate wrapping** — `text-pretty` on settings page subtitles +
  `SettingRow` descriptions (`settings-primitives.tsx`); `text-balance` on the
  wrappable dynamic headings (`Join {teamName}` invite, signup).

Reviewed and deliberately left alone: `ui/badge`'s `text-[.625rem]` (vendored
registry idiom), the px `leading-[16px]/[18px]` meta pills (their font sizes
are px-locked so px leading can't drift), uppercase log-block labels (terminal
idiom, correctly tracked, cased via CSS), email label tracking (already set).

## Verification

- `pnpm check` — exit 0 (format + lint + type-check).
- `pnpm --filter @wrightful/dashboard test` — 112 files, 1313 tests pass
  (includes the updated `cn.test.ts` and the new legacy-name guard).
- `pnpm --filter @wrightful/dashboard build` — built CSS inspected: all seven
  renamed utilities generate with the baked letter-spacing intact
  (e.g. `.text-title{letter-spacing:var(--tw-tracking,-.3px);font-size:22px}`).

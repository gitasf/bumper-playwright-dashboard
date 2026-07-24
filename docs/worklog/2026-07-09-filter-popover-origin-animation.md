# 2026-07-09 — Filter popovers + date-range popover: complete the origin-aware enter/exit animation

Follow-up to the design-craft animation pass (`2026-07-09-animation-opportunities.md`,
`2026-07-09-design-craft-review-fixes.md`). Several trigger-anchored overlays snapped in
instantly, while others — the nav team/project switcher (`ui/nav-combobox`), tooltips,
preview cards — scale in from their trigger. This aligns them.

The gap spanned **four** Base UI primitives, each with its own `ui/` wrapper, which is why
it wasn't a one-file fix: `Combobox` (faceted filters), `Popover` (date-range "All time"
picker + several menus), `Menu` (dropdown/context menus), and `Autocomplete`. Each wrapper
already set `origin-(--transform-origin)` but was missing the enter/exit scale+opacity
endpoints (and `menu` had no transition at all), so each appeared at full scale/opacity in
one frame.

## What changed

The filter popovers all render through `ComboboxFilterPopup` → `ComboboxPopup`
(`src/components/ui/combobox.tsx`). That popup's styled box (the `<span>` wrapper carrying
`border` / `bg-popover` / `shadow`) already had `origin-(--transform-origin)` **and**
`transition-[scale,opacity]` — but **no `data-starting-style` / `data-ending-style`
scale+opacity**, so there was nothing to transition between. The `transition` was dead
code; the popup appeared at full scale/opacity in one frame.

Fix: add the enter/exit endpoints, mirroring the values already proven in
`ui/nav-combobox` (`scale-98` + `opacity-0`):

```
has-data-[starting-style]:scale-98  has-data-[starting-style]:opacity-0
has-data-[ending-style]:scale-98    has-data-[ending-style]:opacity-0
```

**Why `has-data-[…]` and not plain `data-[…]`:** Base UI sets `data-starting-style` /
`data-ending-style` on the inner `Combobox.Popup`, but the visible box we scale is the
outer `<span>` wrapper (the Popup is its child). The `<span>` therefore reacts to its
child's transition state via `:has()`. `--transform-origin` is set by Base UI on the
`Positioner` and inherits down to the span, so the scale correctly originates from the
trigger edge. Confirmed attribute names in
`node_modules/@base-ui/react/combobox/popup/ComboboxPopupDataAttributes.d.ts`.

This is the minimal completion of the clearly-intended animation — no structural change to
the shared popup, so no risk to the scroll/max-height behaviour of the other comboboxes
that share `ComboboxPopup`.

Duration/easing: inherits the span's existing `transition` (Tailwind default ~150ms), in
the 150–250ms dropdown band. The global `prefers-reduced-motion` layer in `styles.css`
already damps it.

## Details

| File                                 | Change                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/ui/combobox.tsx`     | `ComboboxPopup` span: add `has-data-[starting-style]`/`has-data-[ending-style]` `scale-98`+`opacity-0` endpoints                                         |
| `src/components/ui/popover.tsx`      | `PopoverPopup`: extend `transition-[width,height]` → `transition-[width,height,scale,opacity]` + `data-[starting-style]`/`data-[ending-style]` endpoints |
| `src/components/ui/menu.tsx`         | `MenuPopup`: add `transition-[scale,opacity]` + `data-[starting-style]`/`data-[ending-style]` `scale-98`+`opacity-0` (had `origin`, no transition)       |
| `src/components/ui/autocomplete.tsx` | `AutocompletePopup` span: same `has-data-[…]` completion as `ComboboxPopup` (identical dead-`transition` pattern)                                        |

### Why the selector differs between files

Base UI sets `data-starting-style`/`data-ending-style` on the `*.Popup` primitive in every
case. When that Popup **is** the styled box (`popover`, `menu`) the endpoints go straight on
it with `data-[starting-style]:…`. When the styled box is a `<span>` _wrapping_ the Popup
(`combobox`, `autocomplete`) the span reads its child's state with
`has-data-[starting-style]:…` (`:has()`). Same animation, `scale-98`+`opacity-0`, matching
`ui/nav-combobox`; different anchor element.

`PopoverPopup` is shared by five call sites (date range, workspace switcher, sidebar user
menu, run-history hover, run-tests popover) — all trigger-anchored, so origin-aware
scale-in is the right behaviour for each.

## Full sweep of overlay primitives

The user asked whether other overlays were missed because they use different Base UI
primitives. Audited every popup/overlay in `ui/`:

- **Already correct (origin-aware scale-in):** `tooltip`, `preview-card`, `nav-combobox`.
- **Fixed here:** `popover`, `combobox`, `menu`, `autocomplete`.
- **Intentionally centered — NOT origin-aware (modals):** `dialog`, `alert-dialog`,
  `command` (centered scale), `sheet` + `drawer` (edge slide-in). Per the animation
  guidance, modals are exempt from trigger-origin scaling — they are not anchored to a
  trigger — so these are correct as-is.
- **`select` — deliberately left alone.** `SelectPopup` defaults to
  `alignItemWithTrigger={true}`, where Base UI opens the popup with the selected item
  aligned over the trigger and runs its own height/scale reveal from that item. Layering a
  `scale-98`+opacity transform on top would double-animate and fight that built-in motion —
  which is exactly why the COSS registry ships `select` without it. Only in-app use is the
  role picker in `settings/.../members.tsx`.

## Verification

- `pnpm check` → all four changed `ui/` files clean (format + lint + type-check). The only
  reported failure is a pre-existing formatting nit in the untracked
  `2026-07-09-animation-opportunities.md` (a parallel agent's file), not these changes.
- Not yet visually verified in the running app (dev server is the user's to run) — open any
  faceted filter (status on the runs list), the date "All time" popover, and any dropdown
  menu, and confirm each scales in from its trigger and fades out on close, matching the nav
  switcher.

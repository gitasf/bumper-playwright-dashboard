# 2026-07-09 — Thermo-nuclear code-quality review fixes (design-craft branch)

## What changed

Ran a strict maintainability/abstraction review (multi-agent fan-out + adversarial
verification) over the design-craft branch diff — the four themes from
`2026-07-09-avatar-ssr-first.md`, `2026-07-09-design-craft-review-fixes.md`,
`2026-07-09-animation-opportunities.md`, and
`2026-07-09-filter-popover-origin-animation.md`. The PR came back structurally clean
(no >1k files, no spaghetti, no boundary leaks). Applied the six findings that survived
verification. All are behavior-preserving; the two structural ones **delete** complexity
rather than move it.

### 1. Avatar: drop the vestigial Base UI primitive (`ui/avatar.tsx`)

The SSR rewrite replaced Base UI's `Avatar.Image` with a native `<img>`, but `Avatar`
(root) and `AvatarFallback` still routed through `@base-ui/react/avatar`. Base UI's
`AvatarRoot` exists only to hold an `imageLoadingStatus` in context; `AvatarFallback`
renders while that status `!== 'loaded'`. Since the native `<img>` never calls
`setImageLoadingStatus`, the status was frozen at `'idle'` forever — so the fallback was
the permanent base layer _by accident_, via a documented "magic invariant." A future
reader re-introducing `Avatar.Image`, or cleaning up the seemingly-unused state, would
silently break the layering.

Fix: render `Avatar` and `AvatarFallback` as plain styled `<span>`s (identical DOM —
Base UI's Root/Fallback already emitted only a `<span>`; no CSS reads their state
attributes), drop the `@base-ui/react/avatar` import and the unused
`export { AvatarPrimitive }` (grep-confirmed zero external consumers). `AvatarImage`
(the native `<img>`) is unchanged. The "fallback is the permanent base layer" contract
is now self-evident. Updated the `actor-avatar` / `user-avatar` docstrings that called it
"the Base UI `Avatar` primitive."

### 2. Spinners: collapse the `--animate-spin-fast` sub-theme to one theme override (`styles.css`)

The "faster spinners" work was a new `--animate-spin-fast` token + 6 call-site swaps +
an extra reduced-motion selector line. Since **nothing** consumes Tailwind's default
`animate-spin` (grep-confirmed zero plain `animate-spin` usages), this collapses to a
single override in `@theme`:

```css
--animate-spin: spin 0.6s linear infinite;
```

Every call site (`running-spinner`, `status-glyph`, `monitors/monitor-status`,
`ui/spinner`, the loading toast icon) reverts to plain `animate-spin`; the token and the
`.animate-spin-fast` reduced-motion carve-out disappear. Net: one changed line instead of
~8, and there's no longer any way to accidentally ship a slow 1s spinner. Documented the
deliberate framework-default override in-place (contrast with the `--shadow-lg` comment,
which warns _against_ overriding defaults the ui/ system relies on — spinners rely on
nothing). Verified in the compiled bundle: `.animate-spin{animation:.6s linear infinite
spin}`, `@keyframes spin` emitted, reduced-motion re-enables `.animate-spin` at 1.5s.

### 3. Single-source the copy-pop easing curve (`styles.css`)

`--animate-copy-pop` inlined `cubic-bezier(0.22,1,0.36,1)` — byte-identical to the
adjacent `--ease-out-strong` token whose stated job is to be the one source of truth for
that curve. Changed to `--animate-copy-pop: copy-pop 150ms var(--ease-out-strong);` and
reordered so the token precedes its consumer. Verified in the compiled bundle: the
`var()` reference is preserved in `.animate-copy-pop` and `--ease-out-strong` is emitted
to `:root`, so the resolved curve is unchanged.

### 4. Popover animation: match the registry idiom (`ui/menu.tsx`, `ui/popover.tsx`)

These two introduced the bracketed `data-[starting-style]:scale-98 …` arbitrary-variant
form, diverging from the bare `data-starting-style:scale-98 …` idiom every pre-existing
sibling uses (`nav-combobox`, `preview-card`, `tooltip`, `command`, `toast`) — including
the `nav-combobox` the sweep claims to mirror. Both compile to the identical
`[data-starting-style]` selector; dropped the brackets for uniformity. (`combobox` /
`autocomplete` keep `has-data-[…]` — the bracket is required there for the `has-`
combinator; correct as written.)

### 5–6. Doc accuracy

- Monitor exec-row docstrings (`monitors/[monitorId]/index.tsx`) still called the rows
  "an expandable `<details>` (no-JS)" after they were migrated to `<Disclosure>` (Base UI
  Collapsible, JS-required). Corrected both.
- The `design-craft-review-fixes` worklog documented two changes absent from the shipped
  diff: `scale-[0.97]` press-shrink on `ui/button`/`danger-trigger`/`segmented-control`
  (dropped per the standing no-scale-on-press preference; those files are unmodified) and
  a `--ease-drawer` token (never added). Corrected both entries to match what shipped, and
  updated its "Faster spinners" entry to describe the theme override from #2.

## Verification

- `pnpm --filter @wrightful/dashboard build` → **✓ built in 924ms**; compiled CSS
  inspected and confirms all four CSS-affecting changes resolved correctly.
- `vp test run` on `avatar-ssr.test.tsx` + `visual-diff-modes.test.ts` + `cn.test.ts`
  → **10 passed** (the avatar-ssr guard confirms the native `<img>` still ships in SSR
  HTML after the plain-`<span>` refactor).
- `pnpm check` → **0 errors**, 130 warnings (all pre-existing `no-unsafe-type-assertion`
  in `packages/reporter/*`; none of the changed files are flagged).
- Residual grep: zero `animate-spin-fast`, `AvatarPrimitive`, `@base-ui/react/avatar`,
  or `ease-drawer` references remain.
- Not visually re-verified in a running browser (dev server is the user's to run) —
  presentational changes; recommend a quick pass on avatar load, spinner speed, copy-pop,
  and popover open/close.

### Follow-up: defensive hardening of the "rejected" findings

Verification rejected four findings because they don't manifest today. Three were cheap
latent footguns and were hardened on request:

- **`AvatarImage` failure keyed to `src`** (`ui/avatar.tsx`). Replaced the bare `failed`
  boolean with a `failedSrc` string and re-ran the mount check on `src` change, so a later
  `src` swap at the same position re-attempts the new photo instead of staying blank
  forever. (Didn't manifest — every call site keeps `src` stable per mount — but the
  boolean was a trap for future reuse.)
- **Unified avatar loading rule** (`actor-avatar.tsx`). Added `loading="lazy"` to match
  `UserAvatar`, replacing the eager/lazy split. The SSR `<img>` means visible avatars still
  fetch on first paint; off-screen avatars far down a long run/test list now defer. (This
  split was pre-existing on `main`; it's now one consistent rule. Behavior change: list
  actor avatars below the fold defer their fetch until scrolled near.)
- **`SubmitButton` invariants** (`submit-button.tsx`). Spread caller props first, then set
  `ref` / `loading` / `type="submit"` after, so no caller prop can clobber the invariants
  the component owns.

Left as-is: the duplicated `width`/`height` on `AvatarImage` (layout-inert here, but a
correct intrinsic-size declaration — best-practice, not dead code), and the idea of a
shared popup enter/exit class constant (one constant can't span the bare / bracketed /
`has-` anchor flavors cleanly, so per-file inline stays correct).

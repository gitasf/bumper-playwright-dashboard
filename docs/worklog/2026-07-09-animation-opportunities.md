# 2026-07-09 — Animation opportunities: submit-pending, monitor disclosures, copy feedback

Follow-up to the design-craft review (`2026-07-09-design-craft-review-fixes.md`). That
pass fixed existing motion; this one adds three _missing_ animations that survived the
"justified motion" bar from the `apple-design` / `review-animations` / `emil-design-eng`
skills. Everything is CSS-only — no JS animation library was added (see the review's
conclusion that Motion has no justified home in this dashboard yet).

## What changed

### 1. Progressive-enhancement pending state on native server forms

New `src/components/submit-button.tsx` — a `"use client"` `<SubmitButton>` that wraps
`ui/button` and shows its spinner + disables from the moment its owning `<form>` is
submitted until the browser navigates away.

**Why a PE listener and not `useNavigation()`:** Void's client runtime only listens for
`click` / `change` / `popstate` / `abort` — there is **no `submit` listener**. Plain
native `<form method="post">` posts (which these forms deliberately are, for the no-JS
path) do a full-page POST → redirect → reload and are _not_ intercepted, so
`useNavigation().state` never becomes `"submitting"` for them (only `useForm`/`action()`
are SPA). The button therefore listens to its own `form` (`button.form`) for the native
`submit` event — which preserves no-JS submission, disambiguates per-form automatically
(each button hears only its own form), and resets for free on the next page load (and on
bfcache restore via `pageshow`). The `submit` event only fires after native validation
passes, so an invalid form never leaves the button stuck spinning.

Applied to the deliberate save/create forms only (users wait on these):
`monitor-form`, `http-monitor-form`, `tcp-monitor-form`, settings `general` (×2),
`teams/new`, `projects/new`, `keys` (updateGeneral + updateCodeowners), `groups`
(createGroup + saveGroup). **Left alone:** client `useMutation` forms that already show
`loading` (`keys` mint, `members` invite, `profile`), and the intentional no-JS
per-row destructive/toggle forms (remove/leave/revoke/delete/pause).

### 2. Monitor exec-row disclosures → Base UI Collapsible

New `src/components/disclosure.tsx` — a small `"use client"` wrapper over the `ui/`
Collapsible (`CollapsibleTrigger` as a full-width `group/disclosure`, `CollapsibleContent`
for the body). The monitor detail page (`.../monitors/[monitorId]/index.tsx`) HTTP and TCP
execution rows were native `<details>/<summary>` whose chevron animated but whose body
teleported open/closed. They now use `<Disclosure>`, so the panel animates height via the
Collapsible's `transition-[height]`, and the chevron rotates on
`group-data-[panel-open]/disclosure:rotate-180`. Trade-off: the disclosure now needs JS to
toggle (Base UI is client-only) — acceptable on this authed, hydrated page.

### 3. Copy-to-clipboard confirmation pop

New `copy-pop` keyframe + `--animate-copy-pop` token in `styles.css` (opacity 0→1 +
scale 0.6→1, 150ms strong ease-out, no overshoot to match the crisp personality). Applied
to the `Check` icon that replaces `Copy` on success in `artifacts-rail` (terminal block +
copy-prompt button) and the `members` invite-link field. The incoming `Check` mounts
fresh, so the keyframe plays once per copy. The global reduced-motion layer damps it for
free.

## Details

| File                                                      | Change                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/components/submit-button.tsx`                        | **new** — PE pending submit button                                               |
| `src/components/disclosure.tsx`                           | **new** — Collapsible-backed disclosure                                          |
| `src/styles.css`                                          | `copy-pop` keyframe + `--animate-copy-pop` token                                 |
| `.../monitors/[monitorId]/index.tsx`                      | two `<details>` → `<Disclosure>`; chevron → `group-data-[panel-open]/disclosure` |
| `monitor-form` / `http-monitor-form` / `tcp-monitor-form` | submit `Button` → `SubmitButton`                                                 |
| `settings/teams/[teamSlug]/general`                       | 2 saves → `SubmitButton`                                                         |
| `settings/teams/new`, `.../projects/new`                  | create → `SubmitButton`                                                          |
| `.../p/[projectSlug]/keys`                                | updateGeneral + updateCodeowners → `SubmitButton`                                |
| `settings/teams/[teamSlug]/groups`                        | createGroup + saveGroup → `SubmitButton`                                         |
| `artifacts-rail`, `members`                               | copy `Check` icon gets `animate-copy-pop`                                        |

## Verification

- `pnpm check` → **exit 0**, 0 errors / 130 pre-existing warnings (reporter + e2e
  `no-unsafe-type-assertion`, none in changed files).
- `apps/dashboard` `tsgo --noEmit` (via `pnpm --filter @wrightful/dashboard run typecheck`)
  → clean; confirms `ui/button` forwards `ref` (used by `SubmitButton`).
- Dashboard unit tests → **1219 + 283 passed**, 4 skipped, 0 failures.
- Not yet visually verified in the running app (dev server is the user's to run) — the
  three interactions (form spinner on save, animated monitor exec-row open/close, copy
  pop) should be confirmed live.

## Note

Implemented alongside a parallel agent applying the review fixes to the same branch
(`design-craft-review-fixes` + `avatar-ssr-first` worklogs, button scale-on-press,
easing/spin tokens, the reduced-motion/transparency/contrast layer). These changes are
additive and independent; the shared `styles.css` edits sit in different regions.

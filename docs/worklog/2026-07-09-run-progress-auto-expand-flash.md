# 2026-07-09 — Fix Tests-tab accordion "closed → open" flash on run-detail load

## What changed

On the run-detail Tests tab (`/t/:teamSlug/p/:projectSlug/runs/:runId`), the
file/project test-group accordions visibly rendered **collapsed** and then popped
**open** a frame later on first load. The worst groups are meant to auto-expand
immediately (server-flagged `expandedByDefault`), so the collapsed frame read as a
flash/jank.

Root cause was an **effect-timing** issue, not SSR-vs-hydration state as first
suspected:

- `<RunProgress>` (`src/components/run-progress.tsx`) is a `"use client"` island,
  but its group list is **not** SSR-seeded — the `"run-groups"` TanStack
  `useInfiniteQuery` is `pending` on the server, so SSR (and the first hydration
  paint) render `<TestsListSkeleton>`, not accordions.
- After hydration the client fetches the groups. They first render **collapsed**
  because `expanded` initializes to an empty `Set`. The browser **commits/paints
  that frame**.
- Only _then_ did a post-paint `useEffect` call `setExpanded(def)` to open the
  server-flagged default groups — one paint later. That first committed collapsed
  frame is the flash.

## Fix

Moved the one-shot auto-expand from a **post-paint `useEffect`** to a
**render-phase state update** (React's "adjust state during render" pattern), so
the flagged groups paint open on the _same_ committed frame the skeleton data
first arrives. React coalesces a render-phase `setState` on the currently-rendering
component — it discards the collapsed tree and re-renders **before committing to
the DOM** — so the intermediate collapsed frame never reaches the screen.

The latch guard changed from a **ref** (`didAutoExpand`) to **state**
(`autoExpandDone`). This is a genuine correctness upgrade, not cosmetic: a
render-phase `ref.current = true` mutation can be discarded/replayed under
StrictMode or concurrent rendering, which could consume the one-shot latch
_without_ committing the paired `setExpanded` — state is transactional with the
render. `onGroupBy` resets `setAutoExpandDone(false)` (was `didAutoExpand.current
= false`) so each group-by axis re-auto-expands.

The latch _predicate_ is unchanged — the old effect's sequential early-returns
(`!didAutoExpand` → `!isPlaceholderData` → `firstPage` → `def.size > 0` →
`!(isRunning && !hasFailingGroup)`) map one-to-one onto the new conditional, so
all four latch scenarios are preserved:

- terminal run latches on first paint (incl. the passing fallback so the list is
  never fully collapsed),
- a run watched live from empty defers the latch until a real failing group
  appears (`hasFailingGroup`),
- an axis change skips the `keepPreviousData` placeholder and re-latches on fresh
  data,
- a WS reconnect's background refetch (same query key) does not re-latch and does
  not clobber the user's manual toggles.

## Files

| File                                             | Change                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/components/run-progress.tsx` | `didAutoExpand` ref → `autoExpandDone` state; auto-expand `useEffect` → render-phase conditional `setExpanded`/`setAutoExpandDone`; `onGroupBy` resets the state guard. |

No server / schema / wire changes. `useRef` and `useEffect` remain imported —
still used by the other refs/effects in the component (skeleton-refresh throttle,
run-finish refresh, reconnect reseed).

## Verification

- **Adversarial review** (3 independent lenses + synthesis): root cause confirmed
  as the sole automatic closed→open driver; render-phase update confirmed to
  eliminate the collapsed commit without a hydration mismatch (SSR + first client
  render both render the skeleton, data `undefined`); latch predicate proven
  identical to the old effect; no other flash source (the open-group rows skeleton
  is a separate, by-design transition; `ui/accordion` is not used here — the group
  is a hand-rolled `button` + conditional `div`, no CSS open/close transition).
  Verdict: fix-correct, no blocker/major findings.
- `pnpm check` — exit 0 (0 errors; 130 pre-existing warnings live in
  `packages/e2e`, unrelated).
- `tsgo --noEmit` (dashboard) — clean.
- No unit test exercises the island's auto-expand render logic (expected for a
  `"use client"` island); the server `loadRunGroupSkeleton` / `expandedByDefault`
  path is untouched and still covered by `src/__tests__/pg-integration.test.ts`.

# 2026-07-07 — Move owner assignment off the flaky list into a test-detail popover

## What changed

The flaky tests list previously hosted the full test-ownership mutation UI
inline in its Owner column: an "Assign owner" free-text form plus a remove (×)
button on every manual chip, in every row. Feedback: assignment shouldn't live
in the list — the list shows ownership; managing it belongs on the test's own
page, as a popover with a proper "Assigned" picker.

- **Flaky list is now read-only.** The Owner column keeps the chips
  (manual + CODEOWNERS-derived, manual-wins) but the per-row assign/remove
  forms are gone, along with all their plumbing (`ownerActionPath`,
  `ownerRedirectTo`, `canManageOwners`, the `?ownerError` banner) from
  `flaky.tsx` / `flaky.server.ts` / `flaky-test-row.tsx`.
- **The per-test history page (`/t/:team/p/:project/tests/:testId`) gains the
  assignment control**, next to the quarantine control in the header — a
  **Linear-style assignee button**. The button IS the state: it shows the
  current owner (avatar + name, `UsersIcon` + team name for the whole team) or
  a muted "Assign" when unowned, and opens a searchable **single-select**
  popup (the `ComboboxFilterPopup` shape the branch filter uses). One owner at
  a time. Options are the whole team (`@<teamSlug>`) and each team member
  (value = email, labeled with their name), plus any legacy free-text label
  currently assigned so it stays displayable/replaceable. Picking an option
  commits immediately — no Save step; a "No owner" row (shown only while
  assigned) clears manual ownership (un-shadowing CODEOWNERS per
  `mergeOwners`). Iterated from an earlier multi-select-chips draft on
  feedback: one assignee, shown inside the button.
- **The run-scoped result page (`…/runs/:runId/tests/:testResultId`) gets the
  same control** — that's the page flaky-list rows actually link to, so the
  popover must exist there, not only on the testId-keyed history page. Same
  `OwnerAssignControl`, next to the quarantine control; owners + member
  options load in the page's eager point-read batch (single testId), mirroring
  how that page already loads quarantine state.
- **New `set` intent on the owners mutation route** replaces the manual owner
  set wholesale in one transaction. The granular `assign` / `remove` intents
  remain as the no-JS/API surface.
- **All filter popups now use a blended, command-menu-style search input**
  (follow-up feedback, matching Linear): `ComboboxFilterPopup`'s search row is
  a borderless input that IS the popup's top edge, separated from the list by
  a hairline — replacing the boxed mini input. Since the branch filter, the
  faceted toolbar filters (`MultiComboboxFilter`) and the owner picker all
  render through this one component, the change applies everywhere at once;
  non-searchable popups (e.g. Status) are unaffected. Filter option rows also
  standardize on the normal sans font — the runs Branches filter's bespoke
  `font-mono` `renderItem` is gone (it now uses the default row rendering).
- **Owner labels never display as emails** (follow-up feedback):
  `resolveTestOwners` now also resolves member email → NAME (one extra
  team-members read) and returns it as `OwnerEntry.label`; `OwnerBadge`, the
  assignee button, and the picker rows all render the label. The raw opaque
  `owner` string stays the stored identity + mutation key.

## Details

| Area                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/owners-repo.ts`                                             | New `setManualOwners(scope, testId, owners, now)` — delete-then-insert of the manual rows inside `runBatch` (atomic), input de-duplicated, empty set = clear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/lib/owner-schemas.ts`                                           | New `SetOwnersSchema` (`owners: string[]`, each 1–256 chars, max `OWNERS_PER_TEST_MAX = 20`; empty array valid = clear).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `routes/api/t/[teamSlug]/p/[projectSlug]/owners.ts`                  | New `intent=set` leg reading `form.getAll("owner")`; same owner-gated scope resolution, `redirectTo` validation, and `?ownerError=` failure redirect as the existing intents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/components/owner-cell.tsx`                                      | Reduced to display-only: `OwnerBadge` (single chip, exported for reuse) + `OwnerCell` (chip list / "—"). All `<form>` markup removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/components/owner-assign-popover.tsx`                            | NEW client component `OwnerAssignControl` — single-select assignee button. Trigger button shows the effective owner (manual, else CODEOWNERS-derived; legacy multi-owner rows render "first +N") or "Assign"; popup is `ComboboxFilterPopup` (search matches name AND email via a custom `filter`), with a "No owner" clear row and a CODEOWNERS-override note. Selection commits immediately by pointing a hidden plain `<form>` (`intent=set`, one `owner` field, disabled for clear) at the choice and `requestSubmit()`ing — same POST + redirect flow as the quarantine control, so the button re-renders from fresh loader data. Non-managers get read-only `OwnerBadge` chips instead. |
| `pages/t/[teamSlug]/p/[projectSlug]/tests/[testId]/index.server.ts`  | `details` defer gains `owners` (`resolveTestOwners`) and `assignableMembers` (`listTeamMembers`, loaded only for role=owner). Project bundle gains `teamName` + `canManageOwners`; loader surfaces `ownerError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pages/…/tests/[testId]/index.tsx`                                   | `QuarantineControlRegion` generalized to `HeaderControlsRegion` (owners control + quarantine control, one deferred read); `ownerError` banner next to the quarantine one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pages/…/flaky.{tsx,server.ts}`, `src/components/flaky-test-row.tsx` | Owner mutation plumbing removed; column renders `<OwnerCell owners={…} />` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pages/…/runs/[runId]/tests/[testResultId]/index.{tsx,server.ts}`    | Same `OwnerAssignControl` next to the quarantine control; loader's eager batch gains `resolveTestOwners` + `listTeamMembers` (owners only) and surfaces `owners` / `assignableMembers` / `ownerError`; project bundle gains `teamName` + `canManageOwners`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |

No schema/migration changes — `testOwners` and the opaque-owner-label model are
untouched. The owner labels the picker writes (member emails, `@<teamSlug>`)
are ordinary opaque labels to the repo/CODEOWNERS merge logic.

## Verification

- `pnpm check` — pass (0 errors; remaining warnings pre-existing).
- `pnpm test` — dashboard fast lane 1219 passed, workers lane 268 passed
  (4 skipped, pre-existing), reporter suite included via the root script.
- New unit tests in `owners-repo.workers.test.ts` for `setManualOwners`:
  scoped delete predicate `(projectId, testId, source='manual')`, scoped
  insert rows, order-preserving dedupe, empty-set = delete-only, cross-tenant
  isolation. The stub `void/db` gained a `transaction` passthrough for
  `runBatch`.
- **Live browser smoke test** (local Postgres 16 + `pnpm dev` + seeded
  synthetic history + Playwright headless Chromium), on the run-scoped result
  page:
  - flaky list renders owner chips with no inline assign form/buttons;
  - unowned state shows the muted "Assign" button; the popup lists the team
    ("everyone") + the demo member, has NO Save button, and no "No owner" row;
  - clicking the member commits immediately and the assignee (avatar + name)
    renders inside the header button;
  - reopening and picking the team REPLACES the assignment (exactly one
    `testOwners` row in Postgres afterwards);
  - "No owner" (present only while assigned) clears back to "Assign"
    (0 rows).
  - Console noise observed (`Suspense boundary` retries on deferred pages,
    Base UI `nativeButton` warning from `RunHistoryBarHoverCard`) reproduces
    on untouched pages/components — pre-existing, not introduced here.

## Notes / follow-ups

- The synthetic seed generator (`scripts/seed/generator.mjs`) emits
  human-readable testIds containing `/` and `|`, which don't fit the
  `tests/[testId]` route (real reporter ids are 16-hex hashes). Made the smoke
  test work by rewriting one seeded id; worth fixing the generator someday.
- Member groups exist (`memberGroups`) and would slot into the picker as a
  third option kind if wanted later; the popover only offers team + members
  per the request.

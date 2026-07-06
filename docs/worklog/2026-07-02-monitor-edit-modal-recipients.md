# 2026-07-02 — Monitor edit as a modal; alert recipients moved into the edit form

## What changed

Two UX changes to the monitor detail page
(`/t/:teamSlug/p/:projectSlug/monitors/:monitorId`), both owner-only surfaces:

1. **Alert recipients moved off the main page and into the edit form.** The
   "Alert recipients" picker was a standalone `<section>` on the detail page
   with its own `<form>` posting to a dedicated `setAlertRecipients` action.
   It's now a fields-only slot rendered _inside_ the monitor edit form, so a
   single **"Save changes"** persists the monitor config and its recipients
   together. (HTML can't nest `<form>`s, and a modal with two separate submit
   buttons reads poorly — one combined submit is the coherent shape.)

2. **The edit surface is now a modal instead of an inline section.** Clicking
   "Edit" (which still flips `?edit=1`, exactly as before) now opens a Base UI
   `<Dialog>` overlay rather than expanding an inline `<section>`. The
   read-only config/definition stays rendered behind the overlay.

The modal's open state is **driven by the existing `?edit=1` URL flag** (server
prop `editingOpen = isOwner && editing`), which keeps error handling
server-owned: a failed `updateMonitor` redirects to `?edit=1&formError=…` and
the modal re-opens (once hydrated) with the error inline; a successful save
redirects to the bare detail URL and it closes. The flag is mirrored into local
dialog state so Escape / backdrop / the ✕ close instantly, then navigate to the
bare URL to drop `?edit=1`.

**Tradeoff — editing now needs JavaScript.** A Base UI dialog renders through a
client-only portal, so there is no server-rendered edit form; the old inline
`<section>` was editable on the no-JS slow path, the modal is not. This is
inherent to "make it a modal" (an explicit request) and only affects the edit
surface — pause/resume, mute/unmute, and delete stay server-rendered forms. The
docstrings that previously claimed no-JS friendliness were corrected.

## Details

| File                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `…/monitors/alert-recipients-fields.tsx`                                       | **New.** `AlertRecipientsFields` — the recipient radios (`recipientMode`) + group (`group`) / member (`user`) checkboxes, extracted from the old detail-page section. No `<form>`, no submit — a slot for a form.                                                                                                                                                                                                                                                                                                                                      |
| `…/monitors/monitor-edit-dialog.tsx`                                           | **New.** `MonitorEditDialog` — a `"use client"` island wrapping the edit form in a `<Dialog>`. `open` mirrors the `?edit=1`-derived prop; `onOpenChange(false)` hides then `navigate`s to `closeHref`.                                                                                                                                                                                                                                                                                                                                                 |
| `…/monitors/monitor-form.tsx`, `http-monitor-form.tsx`, `tcp-monitor-form.tsx` | Each gained a `recipients?: React.ReactNode` prop, rendered inside the `<form>` just above the enabled/actions footer.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `…/monitors/[monitorId]/index.tsx`                                             | Dropped the inline edit `<section>` + the standalone "Alert recipients" `<section>`; renders the per-type edit form inside `MonitorEditDialog` (owner-gated) with `recipients={<AlertRecipientsFields/>}`. Read-only config sections no longer hide when editing (they sit behind the overlay). Header "Edit" no longer toggles to "Close editor". No `cancelHref` in the modal — the dialog's ✕/Escape/backdrop close it instantly.                                                                                                                   |
| `…/monitors/[monitorId]/index.server.ts`                                       | The `updateMonitor` action builds `alertTargets` (the domain `AlertTargets \| null`) from `recipientMode`/`user`/`group` in the same `formData` and spreads it into the patch (`{ ...parsed.data, alertTargets }`) it hands the `updateMonitor` **repo** call, so config + recipients commit in one atomic UPDATE (recipients aren't persisted if config validation fails). Gated on the `recipientFields` hidden marker: absent ⇒ `undefined` ⇒ targets left untouched. The standalone `setAlertRecipients` action was **deleted** (no other caller). |
| `…/src/lib/monitors/monitors-repo.ts` / `monitor-schemas.ts`                   | `alertTargets?: AlertTargets \| null` (the domain type, not a pre-serialized string) is now a field on `UpdateMonitorInput`; `updateMonitor` serializes it (`serializeAlertTargets`) and applies it in the same `if (patch.X !== undefined) set.X = …` loop as every other column (uniform patch field, atomic single `.set()`). Serialization lives entirely in the repo — the action deals only in the domain model. The now-unused `setMonitorAlertTargets` one-statement helper was removed.                                                       |
| `packages/e2e/tests-dashboard/pages/monitors.page.ts`                          | Recipient locators now scope to the in-modal `form[action*="updateMonitor"]`; added `openEdit()` (hydration-safe retry) + `saveEditButton`; `setSpecific/AllRecipients` save via "Save changes" and wait for the modal to close.                                                                                                                                                                                                                                                                                                                       |
| `packages/e2e/tests-dashboard/monitor-alerts.spec.ts`                          | The recipients round-trip test opens the edit modal before touching the picker and reopens it after each save+reload.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The loader already fetched `members` / `groups` / `alertTargets` for owners
(for the old section) — unchanged; they now feed the in-modal picker.

## Adversarial review follow-ups

A multi-agent review (per-finding verification) surfaced three issues, all
addressed. A later thermo-nuclear quality review surfaced two more (#4, #5).

1. **(medium) No-JS regression + stale comments.** The modal can't render
   server-side (portal), so the "no-JS-friendly" claims were false. Accepted the
   JS-only edit surface (inherent to the modal request) and corrected the
   comments in `monitor-edit-dialog.tsx` + `index.server.ts`.
2. **(low) Cancel closed with a loader-round-trip lag** while ✕/Escape/backdrop
   closed instantly. Dropped the redundant `cancelHref` in the modal.
3. **(low) Non-atomic writes.** Recipients were a second UPDATE after the config
   UPDATE — a transient failure could leave config committed but recipients not.
   Folded `alertTargets` into `updateMonitor`'s single `.set()` (atomic).
4. **(medium) Implicit "every `updateMonitor` POST carries the picker" contract.**
   The action always built a value, so `all` and "picker absent" both collapsed
   to `null` — a future config-only caller would silently reset every monitor to
   "all members". `AlertRecipientsFields` now emits a `recipientFields` hidden
   marker; the action only computes `alertTargets` when it's present (else
   `undefined` = leave untouched), so the coupling is explicit and enforced.
5. **(low) Serialization leaked into the page action.** The action serialized to
   a JSON string and smuggled it through `UpdateMonitorInput` as `string | null`.
   `UpdateMonitorInput.alertTargets` is now the domain `AlertTargets | null`; the
   repo owns `serializeAlertTargets`, keeping the JSON representation behind the
   data layer and the action in the domain model.

**Not addressed — config validation error discards in-flight recipient edits.**
Because recipients share the config `<form>`, a `parsed.error` re-renders from
stored server state and drops the unsaved selection. This is identical to how
the config fields themselves already behave on a server round-trip; the only
real fix is a client-validated form, which contradicts the deliberately
server-owned error model. Left as-is (owner-only, rare).

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — **exit 0** after the #4/#5
  changes (the `AlertTargets`-typed `alertTargets` threads cleanly through the
  action → `UpdateMonitorInput` → repo; no `alert-targets` import cycle).
- `pnpm check` — **exit 0** (format + lint + type-check). 0 errors; the 120
  `no-unsafe-type-assertion` lint warnings are all pre-existing (reporter,
  `error-cause`, etc.) and unrelated.
- `packages/e2e` type-checks clean (`tsgo --noEmit`).
- No vitest suite references the changed surfaces (`setAlertRecipients`,
  `setMonitorAlertTargets`, `recipientMode`, the new components); the pure
  `alert-targets` lib the merged action relies on is unchanged and its
  `alert-targets.workers.test.ts` still covers `buildAlertTargets`/`serialize`/`parse`.
- The Playwright `monitor-alerts.spec.ts` recipients round-trip was updated to
  drive the modal flow (create → open edit → assert "all" → save specific →
  reload/reopen → assert persisted → reset to all → assert). Not executed here
  (boots a real dashboard); logic verified against the rendered DOM.

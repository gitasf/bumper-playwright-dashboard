# 2026-07-01 — Fix invite accept/decline redirect from the team picker

## What changed

Accepting (or declining) a pending invite from the team picker at `/` dumped
the user on the raw JSON API response (`{"ok":true}` at
`/api/invites/:id/accept`) instead of landing them in the joined team. The
picker's Accept/Decline buttons were plain HTML `<form>`s posting directly to
the JSON ingest-style routes, so a full-page browser navigation followed the
POST to the API URL and rendered its JSON body.

Fixed by routing the picker's buttons through **page-level actions** on the
index page (the same colocated-action + redirect pattern the `/invite/:token`
landing page already uses) so a successful accept `302`s to `/t/:teamSlug` and
decline/failed cases fall back to the picker (dropping the now-consumed invite).

To avoid duplicating the security-sensitive redemption logic between the JSON
API routes and the new page actions, the accept/decline core was extracted into
a shared `src/lib/invites.ts` used by both.

## Details

| File                                                      | Change                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/invites.ts`                       | **New.** `acceptDirectedInvite(c, userId, inviteId)` / `declineDirectedInvite(userId, inviteId)` — the invite-match binding (`buildInviteMatchConds`), atomic membership+invite `runBatch` write, idempotent re-accept, and audit record now live in one place. Returns a discriminated result; callers choose JSON vs redirect. Accept also returns `teamSlug` (via join to `teams`) so the picker can redirect. |
| `apps/dashboard/routes/api/invites/[inviteId]/accept.ts`  | Slimmed to an auth + `acceptDirectedInvite` + `c.json` wrapper. Same wire behaviour (`{ ok, teamId }`, 403/404 errors).                                                                                                                                                                                                                                                                                           |
| `apps/dashboard/routes/api/invites/[inviteId]/decline.ts` | Slimmed to an auth + `declineDirectedInvite` + `c.json` wrapper. Same wire behaviour.                                                                                                                                                                                                                                                                                                                             |
| `apps/dashboard/pages/index.server.ts`                    | Added `actions = { accept, decline }`. Accept redirects to `/t/:teamSlug`; decline and any invalid case redirect to `/`.                                                                                                                                                                                                                                                                                          |
| `apps/dashboard/pages/index.tsx`                          | Picker forms now `POST` to `/?accept` / `/?decline` with a hidden `inviteId` input instead of to `/api/invites/:id/*`.                                                                                                                                                                                                                                                                                            |

The JSON API routes are retained (behaviour unchanged) — nothing else calls
them today, but keeping them costs nothing and they remain the programmatic
entry point. The security binding is identical because both paths now call the
same helper.

## Verification

- `pnpm check` — 0 errors (format + lint + typecheck). The 120 lint warnings are
  pre-existing in `packages/reporter` and unrelated.
- `pnpm --filter @wrightful/dashboard test` — 218 + 1113 tests pass (both the
  default and workerd lanes), including the `auth-users.workers` invite-match
  security regression coverage.
- Manual reasoning: accepting from the picker now `302`s into the team instead
  of rendering `{"ok":true}` (the reported bug); declining returns to the picker
  with the invite consumed.

# 2026-05-05 — Directed invites replace GitHub-org-link auto-join

## What changed

Replaced the GitHub-org-link auto-join feature with directed invites. Team
owners now invite specific people (by email or GitHub login) from team
settings; when the invitee signs in, pending invites surface on the team
picker (`/`) with Accept / Decline buttons.

The org-link path was unfixable from the dashboard side: GitHub's `/user/orgs`
silently omits orgs with OAuth-app-access restrictions or unauthorised SAML
SSO, so members of locked-down enterprise orgs got "you must be a member of
that GitHub org to link it" even though they were. Directed invites side-step
the GitHub policy gate entirely — the inviter pre-addresses the invite, and
matching happens on identity (email / login) at sign-in.

## Details

### Schema — new migration `0001_directed_invites`

`packages/dashboard/src/control/migrations.ts`:

| Operation                                                       | Why                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ALTER TABLE account ADD COLUMN githubLogin TEXT`               | Captured at OAuth sign-in; matched against invites' `githubLogin`              |
| `ALTER TABLE teamInvites ADD COLUMN email TEXT` (+ index)       | Identity-keyed invites; nullable so existing token-link invites are unaffected |
| `ALTER TABLE teamInvites ADD COLUMN githubLogin TEXT` (+ index) | Same, for GitHub-login-keyed invites                                           |
| `DROP TABLE userGithubOrgs`                                     | Org cache; obsolete                                                            |
| `DROP TABLE teamSuggestionDismissals`                           | Per-user "don't suggest this team"; obsolete                                   |
| `DROP COLUMN teams.githubOrgSlug` (+ drop index)                | Org-link is gone                                                               |

The `frozen-migrations.test.ts` hash was updated for ControlDO `0000_init`'s
slice end-bound (the file no longer ends with `0000_init`; the hash now slices
through to just before `"0001_`).

### New code

- `packages/dashboard/src/lib/github-login.ts` — `captureGithubLogin(userId, accessToken)` calls `GET /user`, lowercases `.login`, persists on `account.githubLogin`. Best-effort; failures don't block sign-in.
- `packages/dashboard/src/lib/authz.ts::getPendingInvitesForUser(userId)` — selects `teamInvites` where `email = user.email` (case-folded) OR `githubLogin = account.githubLogin`, with `expiresAt > now`. Returns `PendingInvite[]` annotated with `matchedBy`.
- `packages/dashboard/src/routes/api/invite-actions.ts` — `acceptInviteByIdHandler` and `declineInviteByIdHandler` for `POST /api/invites/:inviteId/{accept,decline}`. Both verify the caller's identity matches the invite (`inviteMatchesUser`) before mutating.

### Removed code / wiring

- `packages/dashboard/src/lib/github-orgs.ts` — deleted (`refreshUserOrgs`, `getCachedUserOrgs`, `fetchUserOrgsFromGithub`, `hasReadOrgScope`).
- `packages/dashboard/src/routes/api/team-suggestions.ts` — deleted (`joinTeamHandler`, `dismissSuggestionHandler`, `undismissSuggestionHandler`).
- `packages/dashboard/src/__tests__/github-orgs.test.ts` and `team-suggestions.handler.test.ts` — deleted.
- `lib/authz.ts` — `SuggestedTeam`, `getSuggestedTeamsForUser`; `githubOrgSlug` field stripped from `resolveTeamBySlug` and `ResolvedActiveTeam` (and the `resolveTenantBundleForUser` query/select).
- `lib/better-auth.ts` — `databaseHooks.account.{create,update}.after` now calls `captureGithubLogin` instead of `refreshUserOrgs`.
- `app/components/team-switcher.tsx` — `SuggestedTeam`, `SuggestedItem`, dismissal state stripped; component now renders joined teams only.
- `app/components/app-layout.tsx` — `TeamSwitcherWithSuggestions` removed; sidebar uses plain `TeamSwitcher` directly. Unused `userId` prop dropped from `AppSidebarLoader` / `AppSidebarContents`.
- `app/pages/settings/profile.tsx` — gutted; the page used to render the GitHub-org scope warning + suggestions list. Profile is now a header-only summary; pending invites surface on `/`.
- `app/pages/team-picker.tsx` — replaced the "Available via GitHub" section with a "Pending invites" section. New rule: when there are pending invites, render the picker even if the user has a default landing target — so an invitee with an existing team can still see (and accept/decline) the invite.
- `app/pages/settings/team-detail.tsx` — removed the entire "GitHub organisation" `<section>` and the `update-github-org` action. Replaced the icon-only "+" invite button with an inline form: `<input name="inviteIdentifier"> + Invite`. The action now reads `inviteIdentifier`, classifies via `parseInviteIdentifier` (email if `@`, otherwise GitHub-login shape; rejects invalid), and stores on the row alongside the existing `tokenHash`. Existing token-link flow (empty input) is unchanged. Invite list rows show the directed identifier when set.
- `worker.tsx` — replaced `/api/user/team-suggestions/:teamId/{dismiss,undismiss}` and `/t/:teamSlug/join` mounts with `/api/invites/:inviteId/{accept,decline}`.

### Identity-match security

`acceptInviteByIdHandler` and `declineInviteByIdHandler` look up the invite by id and then confirm via `inviteMatchesUser` that the _caller's_ `user.email` (case-folded) or `account.githubLogin` matches one of the invite's identifiers. A leaked invite id can't be redeemed by a third party.

### Pre-existing OAuth users

`account.githubLogin` is null for OAuth users who signed in before this lands; it backfills automatically on their next sign-in via `account.update.after`. In the meantime, email-keyed invites still resolve from `user.email`. Decision documented per the plan ("accept the gap").

## Verification

- `pnpm --filter @wrightful/dashboard test` — **330 / 330 passed** (was 359 before; the 29-test delta is the two deleted test files, `github-orgs.test.ts` and `team-suggestions.handler.test.ts`, plus the removed `getSuggestedTeamsForUser` describe block).
- `pnpm typecheck` — no new errors in changed files. (Six pre-existing test-file errors in `runs-filter-bar.test.tsx` and `run-progress-broadcast.test.ts` remain, unchanged.)
- `pnpm lint` — 41 warnings, no errors. Two `no-unsafe-type-assertion` warnings on the new `github-login.ts:26` and pre-existing `app-layout.tsx:127` — both follow the project's existing `await res.json() as Shape` pattern (same as the now-removed `github-orgs.ts:40`).
- `pnpm format:fix` — applied.
- Manual UI verification deferred to the user (per project convention, the agent does not spawn `pnpm dev`). End-to-end check: owner of a team types an email or GitHub login in team settings → "Invite" → invitee signs in (existing or new) → invite appears on `/` → Accept lands them on the team page; Decline removes the invite.

# 2026-07-08 — GitHub profile pictures for inline actor avatars

## What changed

Inline actor avatars (the small colored single-letter tiles next to a run's git
actor) now render the actor's **GitHub profile picture** when the run came from
GitHub, falling back to the existing colored-initial tile otherwise. This shows
up on the project runs list (`RunListRow`) and the run-detail header.

The picture comes straight from GitHub's public, unauthenticated avatar
redirect — `https://github.com/<login>.png` (302 → `avatars.githubusercontent.com`)
— so there is **no backend work, DB column, API round-trip, or token** involved.
`runs.actor` already holds the GitHub login for GitHub runs
(`GITHUB_TRIGGERING_ACTOR` / `GITHUB_ACTOR`, set by the reporter's CI detection).

## Details

| File                                                        | Change                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/github-avatar.ts` (new)                            | `githubAvatarUrl(actor, ciProvider)` → the public avatar URL, or `null`. Gates on `isGithubProvider` (so GitLab/CircleCI logins — which are _not_ GitHub handles — don't resolve to a wrong/404 avatar) and on a `[A-Za-z0-9-]` login shape (so bracketed bots like `dependabot[bot]` fall back to the tile). |
| `src/lib/pr-url.ts`                                         | Exported the existing `isGithubProvider` helper (previously private) so the avatar gate reuses the same provider check as the deep-link builders — keeping "which providers are GitHub" (incl. the legacy seeded `"github"` value) in one home.                                                               |
| `src/components/actor-avatar.tsx`                           | `ActorAvatar` gains an optional `imageUrl?: string \| null`. When set, the GitHub picture renders over the colored-initial tile via the Base UI `Avatar` primitive (see the consistency pass below), falling back to the tile on load error. Default behavior (no image) is unchanged.                        |
| `src/components/run-list-row.tsx`                           | Passes `githubAvatarUrl(run.actor, run.ciProvider)`.                                                                                                                                                                                                                                                          |
| `pages/t/[teamSlug]/p/[projectSlug]/runs/[runId]/index.tsx` | Same, in the run-detail header.                                                                                                                                                                                                                                                                               |

`owner-cell.tsx` (the other `ActorAvatar` caller) was intentionally left as-is —
CODEOWNERS owners are teams / `@org/team` handles / emails, not reliably GitHub
user logins.

## Avatar consistency pass

While adding the GitHub picture, `ActorAvatar` was rebuilt on the existing Base
UI `Avatar` wrapper (`src/components/ui/avatar.tsx`) instead of a hand-rolled
`<span>` + overlay `<img>` (`actor-avatar-image.tsx`, now deleted — Base UI's
`AvatarImage`/`AvatarFallback` do the load-error → fallback swap natively). That
surfaced a broader inconsistency: the app had **five** avatar render sites with
**three** different corner radii (`rounded-[3px]`, `rounded-md`, `rounded-full`),
mostly hand-rolled. They're now unified.

| File                                          | Change                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/ui/avatar.tsx`                | Default avatar shape changed `rounded-full` → **`rounded-md`** (Root + `AvatarFallback`), so every avatar is square-rounded app-wide. This is the single source of truth for avatar shape. |
| `src/components/actor-avatar.tsx`             | Now built on `ui/avatar`; dropped its `rounded-[3px]` override so it inherits `rounded-md`. Keeps the hashed-hue tile as the `AvatarFallback`.                                             |
| `src/components/user-avatar.tsx` (new)        | Shared `UserAvatar` — a person's profile photo with a monospace-initials fallback on the app's neutral `border-line-1 bg-bg-3 text-fg-3` tokens. Built on `ui/avatar`.                     |
| `src/components/sidebar-user-menu.tsx`        | Deleted its local `Avatar` (was `rounded-md`, `muted`/`border` tokens); uses `UserAvatar`.                                                                                                 |
| `pages/settings/teams/[teamSlug]/members.tsx` | Deleted the hand-rolled `<img>`/`<div>` pair (was `rounded-full`); uses `UserAvatar`.                                                                                                      |
| `pages/settings/teams/[teamSlug]/audit.tsx`   | Deleted the hand-rolled initials `<div>` (was `rounded-full`); uses `UserAvatar`.                                                                                                          |
| `src/components/workspace-switcher.tsx`       | `TeamBadge` (hued team-initial tile, was `rounded-md`) now delegates to `ActorAvatar` — team and run-actor tiles are guaranteed identical (shape, hue, typography).                        |

Net: two app-level avatar components — `ActorAvatar` (hued initial + optional
image, for actors/teams) and `UserAvatar` (photo + neutral initials, for people)
— both on the one `ui/avatar` Base UI primitive, so shape can't drift again.

## Verification

- `pnpm check` (format + lint + type-check) — **0 errors** (the 120 warnings are
  pre-existing `no-unsafe-type-assertion` in `packages/e2e`, none in the changed files).
- New unit test `src/__tests__/github-avatar.test.ts` — **5/5 pass** (github-actions
  login, legacy `github` provider, non-GitHub providers → null, missing actor/provider
  → null, bot/space-containing strings → null).
- Confirmed the endpoint out-of-band: `curl -sI https://github.com/joefairburn.png?size=48`
  → `302` to `avatars.githubusercontent.com`.
- Avatar consistency pass re-verified: `pnpm check:fix` (format + lint) **0 errors**
  and `tsgo --noEmit` **clean** after routing all five sites through `ui/avatar`.
  Grep sweep confirms no hand-rolled avatar tiles remain (`avatarHue` / `oklch(0.55`
  / initials-`<img>` only appear inside `actor-avatar.tsx` + `user-avatar.tsx`).

## Follow-ups (not done here)

- The audit log (`pages/settings/teams/[teamSlug]/audit.tsx`) now renders via
  `UserAvatar` but `audit.server.ts` still drops `image` from the row projection,
  so it shows initials only. Passing the fetched `image` through to the row type
  - projection and into `<UserAvatar image={...} />` would light up member photos
    there too (that's the member's `user.image`, which for GitHub-OAuth users
    already _is_ their GitHub avatar).

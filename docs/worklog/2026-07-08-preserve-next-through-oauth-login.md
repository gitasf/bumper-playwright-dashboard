# 2026-07-08 — Preserve `next` through login/signup + GitHub OAuth (fix "No teams yet" after accepting an invite)

## What changed

Fixed a bug where an invited user who opened their `/invite/:token` link, was
bounced to sign in, and authenticated with GitHub (or email/password) landed on
the team picker showing **"No teams yet"** instead of back on the invite page to
join the team.

The invite loader already redirects a signed-out visitor to
`/login?next=/invite/<token>` ([pages/invite/[token]/index.server.ts:56](../../apps/dashboard/pages/invite/[token]/index.server.ts#L56)),
but **neither the login nor the signup page ever read that `next` param**. Both
hardcoded the post-auth destination to `/`:

- GitHub OAuth: `auth.signIn.social({ provider: "github", callbackURL: "/" })`
- Email: `router.visit("/")`

So after the OAuth round-trip the user was dropped on the picker and never
returned to the invite page to accept. Because the tokenless picker only
surfaces _email-directed_ invites matching a _verified_ email (GitHub-directed
invites are deliberately withheld from the tokenless path for handle-reuse
takeover safety — see `buildInviteMatchConds` in `src/lib/auth-users.ts`), the
picker showed "No teams yet".

The fix threads a validated `next` through both auth pages into the email
redirect **and** the GitHub `callbackURL`, so the OAuth flow returns to
`/invite/<token>`, where the directed-invite match (`identityMatchesInvite`,
which honors both verified email and GitHub login behind the secret token) lets
the user join.

## Details

| File                                    | Change                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/dashboard/pages/login.server.ts`  | Read + `safeNextPath`-validate `next`; redirect already-authed users to `next`; return `next` in props.                                                            |
| `apps/dashboard/pages/login.tsx`        | Use `next` for `router.visit(next)` (email) and `callbackURL: next` (GitHub); thread `next` into the `/signup` link.                                               |
| `apps/dashboard/pages/signup.server.ts` | Same `next` handling; **also preserve `next` through the invite-only `/login` bounce** (when `ALLOW_OPEN_SIGNUP` is off) so an invited user doesn't lose the link. |
| `apps/dashboard/pages/signup.tsx`       | Use `next` for email + GitHub redirects; thread `next` into the `/login` link.                                                                                     |

- Reused the existing `safeNextPath` helper (`src/lib/safe-next-path.ts`) — only
  local paths starting with a single `/` (no `//`, `/\`, or control chars) are
  honored; anything else falls back to `/`, closing the open-redirect vector on
  a user-controlled `callbackURL`/redirect.
- Added a companion `hrefWithNext(base, next)` helper alongside `safeNextPath`
  (same file) so the "carry `next` forward as `?next=` unless it's `/`" rule
  lives in one place. Collapsed the three copy-pasted ternaries that encoded it
  (the `/login` invite-only bounce in `signup.server.ts`, the cross-links in
  `login.tsx` and `signup.tsx`) into single calls — `safeNextPath` validates on
  the way in, `hrefWithNext` writes on the way out.
- On invite-only instances (`ALLOW_OPEN_SIGNUP=false`), GitHub OAuth is the only
  account-creation path; the login page still shows "Continue with GitHub", and
  it now returns to the invite link. Verified better-auth's GitHub provider sets
  `emailVerified` from GitHub's verified-email flag, so email-directed invites
  match once the user is returned to the invite page.

## Tests

Added two regression tests to `packages/e2e/tests-dashboard/auth.spec.ts`
(anonymous block):

- **honors a ?next redirect after email sign-in** — `/login?next=/t/…/p/…` →
  sign in → asserts it lands on that path, not `/`. The GitHub `callbackURL`
  consumes the _same_ server-validated `next` prop, so this covers the wiring
  behind the reported OAuth bug (the GitHub provider itself can't be driven in
  e2e).
- **sanitizes a hostile ?next and stays on-origin** — `/login?next=//evil…` →
  sign in → asserts the browser never leaves the app origin (open-redirect
  guard on the user-controlled `callbackURL`/redirect).

The `safeNextPath` helper itself already has unit coverage in
`apps/dashboard/src/__tests__/safe-next-path.workers.test.ts`.

## Verification

- `pnpm check` — 0 errors, 120 (pre-existing) warnings.
- `pnpm test` — dashboard 261 + 1159 pass, reporter 281 pass.
- `pnpm --filter @wrightful/e2e test:dashboard` — full dashboard Playwright
  suite green (51 passed). The two new tests pass explicitly:
  - `auth.spec.ts › honors a ?next redirect after email sign-in`
  - `auth.spec.ts › sanitizes a hostile ?next and stays on-origin`

## Toolchain fixes made this session (separate from the invite fix)

A co-worker bumped `packageManager` to `pnpm@11.10.0`, but pnpm 11 stopped
reading `onlyBuiltDependencies` / `patchedDependencies` from `package.json`'s
`pnpm` block, which broke `pnpm install` (frozen-lockfile config mismatch on the
patches). Completed the migration:

- Moved `patchedDependencies` into `pnpm-workspace.yaml` (matching the lockfile
  paths); `onlyBuiltDependencies` was already migrated to `allowBuilds:` there.
  Left the three transitive native deps pnpm auto-listed (`cpu-features`,
  `protobufjs`, `ssh2`) out of `allowBuilds:` — they were never built before, so
  the default (not built) already matches, and explicit `false` entries just add
  noise.
- Removed the now-ignored `pnpm` block from `package.json`.
- Regenerated stale Void route codegen (`void prepare`) — the co-worker's new
  `runs/:runId/groups` route wasn't in `.void/routes.d.ts`, which surfaced as
  two type errors in `run-progress.tsx`.

### Local-dev environment note (NOT a code change)

The newer wrangler / `@cloudflare/vite-plugin` now **hard-errors** at `vp dev`
boot when `wrangler.jsonc` declares a `hyperdrive` binding but no local
connection string is provided
(`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`). Locally the app
connects directly to Postgres via `DATABASE_URL` (Hyperdrive is prod-only), so
the binding is unused at dev time — but the plugin still requires the var. To
boot `vp dev` or the e2e suite, export it pointing at the same Postgres, e.g.
`export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"`.

## Follow-ups (not done)

- Auto-accept (zero-click) on the invite landing page was considered but not
  implemented — the explicit "Join {team}" confirmation is retained by design.
- Have `pnpm setup:local` / the e2e fixture write
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` into `.env.local`
  so nobody hits the `vp dev` boot error above.

# GitHub installation settings

## What changed

Team General settings now expands each connected GitHub App installation into
its current repository access list. Owners can open the installation's
canonical GitHub settings page to add or remove repository access, or disconnect
the organization from the Wrightful team. Non-owners retain the existing
organization-level connected status, but do not receive the broader private
repository inventory.

The loader reads repository access live with a short-lived installation token;
no repository grant state is duplicated in Postgres. Upstream failures are
isolated per installation so a stale or revoked installation still renders its
local disconnect control. Repository reads paginate up to a defensive
1,000-repository cap and disclose when the displayed list is truncated. The
repository-management link renders only when GitHub returns its canonical,
account-type-aware installation URL; Wrightful does not guess an organization
URL for a personal installation when that metadata request fails.

Disconnecting deletes only the team-scoped `githubInstallations` link, which
immediately prevents future Wrightful check-run and PR-comment token resolution.
It does not uninstall the GitHub App, so an owner can reconnect it later. The
mutation is owner-only, tenant-scoped by both `teamId` and `installationId`, and
recorded as `github_installation.disconnect` in the audit log after the delete
succeeds.

## Why repository changes remain on GitHub

GitHub installation tokens can list the repositories an App may access, but
GitHub's REST endpoints for changing that selection require a classic personal
access token with the broad `repo` scope. Wrightful's OAuth login intentionally
requests only `user:email`, so it does not broaden credential access for this
feature. The dashboard links directly to GitHub's installation settings screen,
where GitHub performs its own organization-admin checks and updates the grant.

## Notable files

- `apps/dashboard/src/lib/github-app.ts`
- `apps/dashboard/pages/settings/teams/[teamSlug]/general.server.ts`
- `apps/dashboard/pages/settings/teams/[teamSlug]/general.tsx`
- `apps/dashboard/src/lib/audit.ts`
- `apps/dashboard/src/__tests__/github-installation-repositories.workers.test.ts`
- `apps/dashboard/src/__tests__/github-settings-ui.test.tsx`

## Verification

- Focused GitHub repository-list, settings UI, and audit tests
- Dashboard typecheck
- Repository `pnpm check`

## Summary

<!-- What does this PR do and why? One or two sentences. -->

## Changes

<!-- Bullet the notable changes. For merge/conflict PRs, list each conflict and how it was resolved. -->

-

## Verification

<!-- What did you run to validate this? Tick what applies and note results. -->

- [ ] `pnpm check` (format + lint + type-check)
- [ ] `pnpm test` (dashboard + reporter unit tests)
- [ ] `pnpm test:e2e` / `pnpm --filter @wrightful/e2e test:dashboard`
- [ ] Manual / other (describe below)

## Screenshots

<!-- Before/after screenshots or screen recordings for any UI change. Delete if not applicable. -->

## Notes & follow-ups

<!-- Anything reviewers should weigh, deferred work, or design decisions left open. Delete if none. -->

## Checklist

- [ ] Worklog entry added under `docs/worklog/` (required for significant changes)
- [ ] Wire-contract changes mirrored in both `packages/reporter/src/types.ts` and `apps/dashboard/src/lib/schemas.ts` (or N/A)

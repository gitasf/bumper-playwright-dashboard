# 2026-07-15 — Remove legacy project naming

## What changed

Removed the retired predecessor name from current project configuration,
community documentation, repository links, and historical decision notes. The
repository now presents Wrightful as its sole identity.

## Details

- The Codex local environment is named `wrightful`.
- Issue and private-vulnerability links target `joefairburn/wrightful`.
- The PRD naming decision describes when the Wrightful identity was finalized.
- The original identity worklog now records the finalized Wrightful surfaces
  without retaining obsolete identifiers.

Generated tool output and nested external worktrees were not rewritten because
their absolute paths reflect their physical checkout locations rather than the
product identity.

## Verification

- Parsed `.codex/environments/environment.toml` with Python's `tomllib`.
- Searched tracked files and the Codex environment configuration for the
  retired name; no matches remain.

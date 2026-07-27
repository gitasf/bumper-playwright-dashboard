/**
 * `Merge <sha> into <sha>` and nothing else — what GitHub generates for the
 * ephemeral `refs/pull/N/merge` commit and for the merge its "Update branch"
 * button pushes onto a PR head. Two bare object names say strictly less than the
 * branch / PR / sha shown beside them, so a run titled with one gets
 * de-emphasized rather than headlining its row. No `/m` flag and matched against
 * the whole message, so `$` also rejects anything with a body: a merge someone
 * did write a message for keeps it.
 *
 * A deliberate second copy of the rule in `packages/reporter/src/ci.ts`, which
 * applies it at capture time — the reporter is a published standalone package, so
 * neither side can import the other. `scripts/backfill-run-titles.mjs` holds a
 * third, POSIX copy for SQL, pinned to this one by `commit-title.test.ts`.
 */
export const GENERATED_MERGE_MESSAGE =
  /^Merge ([0-9a-f]{7,64}) into ([0-9a-f]{7,64})$/i;

export interface CommitTitle {
  /** The subject line, with generated-merge object names shortened. */
  text: string;
  /** True for a message GitHub generated rather than one a human wrote. */
  generated: boolean;
}

/**
 * A run's commit message reduced to something displayable: the subject line, plus
 * whether it carries any human intent. Render it with `CommitSubject`, which owns
 * the styling response to `generated`, or read `.text` where only a string will
 * do.
 *
 * Returns `null` for a missing or blank message, so call sites keep their own
 * empty state.
 */
export function commitTitle(message: string | null): CommitTitle | null {
  if (!message) return null;
  // Trimmed before matching, unlike in the reporter: stored messages can carry
  // surrounding whitespace, since `truncatedText` (schemas.ts) truncates without
  // trimming. The SQL twin `btrim`s for the same reason.
  const trimmed = message.trim();
  const merge = GENERATED_MERGE_MESSAGE.exec(trimmed);
  if (merge) {
    return {
      text: `Merge ${merge[1].slice(0, 7)} into ${merge[2].slice(0, 7)}`,
      generated: true,
    };
  }
  const subject = trimmed.split(/\r?\n/)[0]?.trim();
  return subject ? { text: subject, generated: false } : null;
}

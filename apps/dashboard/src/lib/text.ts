/**
 * First non-empty line of a string (e.g. a commit subject), trimmed, or `null`
 * for empty/whitespace-only input. Shared by the run-history hovercard and the
 * test-history table so the "commit message → subject" reduction has one owner.
 */
export function firstLine(s: string | null): string | null {
  if (!s) return null;
  const line = s.split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : null;
}

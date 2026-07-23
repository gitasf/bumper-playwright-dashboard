/**
 * The last segment of a `/`- or `\`-separated path (a filename from a path, a
 * leaf from an R2 key). Returns the input unchanged when it has no separator,
 * and `""` for a trailing-separator input — callers that want the whole value
 * back in that case should `basename(p) || p`.
 *
 * One home for the "take the trailing segment" idiom that was otherwise
 * hand-rolled (with subtly different separator/fallback handling) across the
 * trace-viewer tabs and the run list.
 */
export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(idx + 1);
}

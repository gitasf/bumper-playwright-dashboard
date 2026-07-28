import type React from "react";
import { cn } from "@/lib/cn";
import { commitTitle } from "@/lib/text";

// Family, weight, and colour only — no size token. Each call site already picked
// the right scale, and mono at that scale beside non-mono siblings reads as
// metadata on its own.
const GENERATED = "font-mono font-normal text-fg-3";

interface CommitSubjectProps {
  /** Raw `runs.commitMessage`. Reduced to a subject here, not by the caller. */
  message: string | null;
  /** Classes for the subject in its normal, authored state. */
  className?: string;
  /**
   * Rendered in place of the subject when there is no message at all. Sits inside
   * the same styled element, so a caller's layout classes still apply.
   */
  fallback?: React.ReactNode;
}

/**
 * A run's commit message as a heading/label: subject line only, generated merges
 * abbreviated and dropped to metadata weight, full message on hover.
 *
 * The single owner of that presentation — surfaces render this rather than
 * reading `commitTitle().generated` and re-deciding the styling.
 */
export function CommitSubject({
  message,
  className,
  fallback,
}: CommitSubjectProps): React.ReactElement {
  const subject = commitTitle(message);
  return (
    // The tooltip carries the full message, which is why the visible text can be
    // a truncated subject with abbreviated object names.
    <span
      className={cn(className, subject?.generated && GENERATED)}
      title={message ?? undefined}
    >
      {subject ? subject.text : fallback}
    </span>
  );
}

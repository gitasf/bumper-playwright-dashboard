import type React from "react";
import { ansiToHtml } from "@/lib/ansi";
import { cn } from "@/lib/cn";

/**
 * ANSI-coloured text. Owns the two justified `dangerouslySetInnerHTML` sites
 * for ANSI output — `ansiToHtml` HTML-escapes its input before colourising,
 * so the markup is safe by construction and the lint suppression only has to
 * exist here. `inline` renders a `<span>` (no `<pre>` block styling) for
 * contexts that can't hold a block element, e.g. an alert title.
 */
export function AnsiPre({
  text,
  className,
  inline,
}: {
  text: string;
  className?: string;
  inline?: boolean;
}): React.ReactElement {
  const Tag = inline ? "span" : "pre";
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: ansiToHtml HTML-escapes before colourising
    <Tag
      className={cn(
        inline ? undefined : "whitespace-pre-wrap break-words font-mono",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
    />
  );
}

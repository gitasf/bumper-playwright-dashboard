import { SearchIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/cn";

/**
 * The shared focus-ring + sizing class string for the compact search-filter
 * field. Pulled out as a pure function so the long, fiddly Tailwind string
 * lives in exactly one place (and is unit-testable). Callers pass `inputClassName`
 * to tweak size — e.g. RunsSearchInput bumps `h-7` to `h-8 text-[13px]`.
 *
 * Note this is intentionally NOT the design-system `ui/Input` — that is a
 * heavier bordered+shadow control. This is the bespoke compact search field
 * (magnifier on the left, bare focus ring) used by the sticky filter toolbars.
 */
export function searchFilterInputClassName(inputClassName?: string): string {
  return cn(
    "h-7 w-full rounded-md border border-line-1 bg-card pl-8 pr-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24",
    inputClassName,
  );
}

export type SearchFilterInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "className"
> & {
  /** Classes merged onto the wrapping `<div className="relative …">`. */
  className?: string;
  /** Classes merged onto the inner `<input>` (e.g. sizing overrides). */
  inputClassName?: string;
};

/**
 * Presentational search field: an absolute-positioned magnifier icon over a
 * compact text input. Behaviour is entirely caller-supplied via the forwarded
 * native input props — a controlled `value`/`onChange` (run-progress), a
 * GET-`<form>` `name`/`defaultValue` (tests catalog), or a debounced navigate
 * wrapper (RunsSearchInput). This component owns only the visual shell so the
 * magnifier positioning and focus-ring class string stop being copy-pasted.
 */
export function SearchFilterInput({
  className,
  inputClassName,
  type = "search",
  ...props
}: SearchFilterInputProps): React.ReactElement {
  return (
    <div className={cn("relative", className)}>
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        className={searchFilterInputClassName(inputClassName)}
        type={type}
        {...props}
      />
    </div>
  );
}

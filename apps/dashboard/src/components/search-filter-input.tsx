import { SearchIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/cn";

/**
 * The shared focus-ring + sizing class string for the compact search-filter
 * field. Pulled out as a pure function so the long, fiddly Tailwind string
 * lives in exactly one place (and is unit-testable). `h-8` is the standard
 * toolbar control height — the same as the filter triggers and segmented
 * controls it sits next to; callers should not override sizing.
 *
 * Note this is intentionally NOT the design-system `ui/Input` — that is a
 * heavier bordered+shadow control. This is the bespoke compact search field
 * (magnifier on the left, bare focus ring) used by the sticky filter toolbars.
 */
export function searchFilterInputClassName(inputClassName?: string): string {
  return cn(
    // text-base below the sm breakpoint: iOS Safari zooms the page when a
    // focused input's font-size is under 16px.
    "h-8 w-full rounded-md border border-line-1 bg-bg-1 pl-8 pr-2.5 text-base sm:text-body text-fg-1 outline-none placeholder:text-fg-3/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 [&::-webkit-search-cancel-button]:appearance-none",
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
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3"
      />
      <input
        className={searchFilterInputClassName(inputClassName)}
        type={type}
        {...props}
      />
    </div>
  );
}

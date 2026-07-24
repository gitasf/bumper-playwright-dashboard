/**
 * Trigger chrome for danger-zone confirms (delete team/project key/account/
 * monitor). Styled as a soft destructive button on the app's `fail` tokens;
 * shared as a class string because most call sites are `<summary>` elements
 * (a `<details>` disclosure), which `ui/Button` doesn't model. `h-8` matches
 * the standard control height.
 */
export const DANGER_TRIGGER_CLASSES =
  "inline-flex h-8 cursor-pointer list-none items-center justify-center gap-1.5 self-start rounded-[5px] border border-fail/30 bg-fail-soft px-[11px] text-body font-medium text-fail transition-colors hover:bg-fail/20 disabled:opacity-50 [&::-webkit-details-marker]:hidden";

"use client";

import { ChevronDown, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

/**
 * Shared scaffolding for the two monitor forms (`monitor-form.tsx` and
 * `http-monitor-form.tsx`). The forms' *logic* differs (code editor vs
 * assertion builder) but the chrome — field labels, limit/error banners, the
 * styled native `<select>`, and the enabled-switch footer row — was authored
 * twice and had already started to drift (the http interval select lost the
 * browser form's `w-full`). One module keeps the copy and styling in lockstep.
 */

/**
 * Compact field label matching the design's `FieldLabel` (fg-2, 12px) —
 * a thin re-skin over the ui `Label` wrapper rather than a raw `<label>`.
 */
export function FieldLabel({
  children,
  className,
  htmlFor,
}: {
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <Label
      className={cn("mb-1.5 block text-xs text-fg-2 sm:text-xs", className)}
      htmlFor={htmlFor}
    >
      {children}
    </Label>
  );
}

/**
 * Styled native `<select>` — submits without client wiring (no-JS slow path).
 * Full-width by default; callers narrow it via `className` (twMerge lets a
 * passed width win over the base `w-full`).
 */
export function NativeSelect({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span
      className={cn(
        "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24",
        className,
      )}
    >
      <select
        className="h-8.5 w-full appearance-none rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] pr-8 font-mono leading-8.5 text-foreground outline-none sm:h-7.5 sm:leading-7.5"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-3 -translate-y-1/2 text-fg-3"
      />
    </span>
  );
}

/**
 * The limit-reached and inline-error banners shown above both forms.
 * `error` is the action's `?formError=` redirect payload.
 */
export function MonitorFormBanners({
  limitReached,
  error,
}: {
  limitReached: boolean;
  error?: string | null;
}) {
  return (
    <>
      {limitReached && (
        <div className="flex items-center gap-2.5 rounded-lg border border-fail/30 bg-fail-soft px-3.5 py-2.5 text-[12.5px]">
          <X className="size-3.5 shrink-0 text-fail" />
          <span className="text-fg-1">Monitor limit reached.</span>
          <span className="text-fg-3">Delete one or upgrade to add more.</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2.5 rounded-lg border border-fail/30 bg-fail-soft px-3.5 py-2.5 text-[12.5px]">
          <X className="size-3.5 shrink-0 text-fail" />
          <span className="text-fg-1">{error}</span>
        </div>
      )}
    </>
  );
}

/**
 * The Enabled/Paused switch in the actions footer. Controlled `<Switch>` with
 * a hidden `enabled` mirror so it submits like a form checkbox
 * (`CreateMonitorSchema` coerces `"on"`/absent), plus the state-aware copy.
 */
export function EnabledSwitchRow({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <Switch checked={enabled} onCheckedChange={onChange} />
      {/* Hidden mirror so the switch submits like a form checkbox. */}
      {enabled && <input name="enabled" type="hidden" value="on" />}
      <span>
        <span className="block text-[13px] font-medium text-foreground">
          {enabled ? "Enabled" : "Paused"}
        </span>
        <span className="block text-[11.5px] text-fg-3">
          {enabled
            ? "Runs on schedule as soon as it’s saved."
            : "Saved but won’t run until resumed."}
        </span>
      </span>
    </label>
  );
}

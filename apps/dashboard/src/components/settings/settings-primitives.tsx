import type * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Scroll container + max-width wrapper for a settings page body. Sits inside
 * the settings layout's sidebar shell. Mirrors the prototype's ~820px column
 * with vertical padding.
 */
export function SettingsPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto h-full">
      <div className="mx-auto w-full max-w-[820px] px-8 pb-16 pt-8">
        {children}
      </div>
    </div>
  );
}

/**
 * Settings page header — small "Settings" kicker, title, optional subtitle.
 * Sits at the top of every /settings/* page body.
 */
export function SettingsHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="text-caption font-medium tracking-[0.1px] text-fg-3">
        Settings
      </div>
      <h1 className="mt-1 font-semibold text-title">{title}</h1>
      {subtitle && (
        <p className="mt-1.5 max-w-[600px] text-body text-pretty text-fg-3">
          {subtitle}
        </p>
      )}
    </div>
  );
}

/**
 * Section card — bordered header with title + optional subtitle, body slot,
 * optional bordered footer. Used for every group of settings on a page.
 */
export function SettingsCard({
  title,
  subtitle,
  children,
  footer,
  tone = "default",
  className,
  "data-testid": dataTestId,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tone?: "default" | "danger";
  className?: string;
  /** Optional test hook for e2e locators (e.g. a per-group settings card). */
  "data-testid"?: string;
}) {
  const isDanger = tone === "danger";
  return (
    <div
      className={cn(
        "mb-4 rounded-[9px] bg-bg-1",
        isDanger ? "border border-fail/30" : "border border-line-1",
        className,
      )}
      data-testid={dataTestId}
    >
      <div
        className={cn(
          "px-[18px] py-3.5",
          isDanger
            ? "border-b border-fail/20 bg-fail-soft"
            : "border-b border-line-1",
        )}
      >
        <div
          className={cn("font-semibold text-body-lg", isDanger && "text-fail")}
        >
          {title}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-body text-pretty text-fg-3 leading-relaxed">
            {subtitle}
          </div>
        )}
      </div>
      <div className="px-[18px] py-4">{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-2.5 border-t border-line-1 bg-bg-0 px-[18px] py-2.5">
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * Form field row — small label, control, optional hint. The control slot
 * accepts any input/select/etc. — typically `<Input>` from `ui/`.
 */
export function SettingsField({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="mb-3.5 flex flex-col gap-1.5">
      <label className="font-medium text-caption text-fg-2" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && (
        <span className="text-caption text-fg-3 leading-snug">{hint}</span>
      )}
    </div>
  );
}

/**
 * Compact divider used to start a separate group of sub-cards (e.g. above
 * a Danger zone).
 */
export function SettingsGroupGap() {
  return <div className="h-3" />;
}

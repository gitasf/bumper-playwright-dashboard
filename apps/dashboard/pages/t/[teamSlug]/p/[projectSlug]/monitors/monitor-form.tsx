"use client";

import { ChevronDown, Play, X } from "lucide-react";
import { useState } from "react";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { INTERVAL_OPTIONS } from "./monitors-ui.shared";

/**
 * The default Playwright spec seeded into a freshly-created monitor's editor.
 * A minimal, runnable smoke check the user edits to point at their own flow —
 * concrete enough to run as-is, simple enough to read at a glance.
 */
export const DEFAULT_MONITOR_SPEC = `import { test, expect } from "@playwright/test";

test("homepage loads", async ({ page }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example/);
});
`;

export interface MonitorFormProps {
  /** Where the form POSTs — `${monitorsBase}/new` or `…/${id}?updateMonitor`. */
  action: string;
  submitLabel: string;
  /** Inline error surfaced from the action's redirect (`?formError=`). */
  error?: string | null;
  defaultName?: string;
  defaultSource?: string;
  defaultIntervalSeconds?: number;
  defaultEnabled?: boolean;
  /** Optional cancel link (detail page → back to detail). */
  cancelHref?: string;
  /** When set, show a project-limit banner above the form. */
  limitReached?: boolean;
}

/**
 * Shared create/edit form for a monitor. Plain `<form method="post">` so it
 * works on the no-JS slow path; the one interactive leaf is the controlled
 * `<CodeEditor>` (a client island) which mirrors its value into a hidden
 * `source` field. The enabled `<Switch>` is likewise controlled and mirrors
 * into a hidden `enabled` checkbox-style field the `CreateMonitorSchema`
 * coerces (`"on"`/absent). Interval is a native `<select>` so it submits
 * without client wiring and stays in lockstep with `INTERVAL_OPTIONS`.
 *
 * Layout follows the design: a 2-col [Name · Interval] row, the Browser-check
 * code editor with helper text, then an actions row pairing the Enabled switch
 * (with a state-aware description) against the Run-once / Cancel / submit
 * cluster. Server actions own validation + redirect; `error` is surfaced inline
 * (banner + editor border treatment).
 */
export function MonitorForm({
  action,
  submitLabel,
  error,
  defaultName = "",
  defaultSource = DEFAULT_MONITOR_SPEC,
  defaultIntervalSeconds = 300,
  defaultEnabled = true,
  cancelHref,
  limitReached = false,
}: MonitorFormProps) {
  const [source, setSource] = useState(defaultSource);
  const [enabled, setEnabled] = useState(defaultEnabled);

  return (
    <form
      action={action}
      className="m-0 flex flex-col gap-[18px]"
      method="post"
    >
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

      {/* Meta fields: Name (flex) + Interval (fixed). */}
      <div className="grid grid-cols-[1fr_200px] gap-4">
        <div>
          <FieldLabel htmlFor="monitor-name">Name</FieldLabel>
          <Input
            aria-invalid={error ? true : undefined}
            defaultValue={defaultName}
            id="monitor-name"
            maxLength={120}
            name="name"
            nativeInput
            placeholder="Checkout — reach payment"
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor="monitor-interval">Interval</FieldLabel>
          <span className="relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
            <select
              className="h-8.5 w-full appearance-none rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] pr-8 font-mono leading-8.5 text-foreground outline-none sm:h-7.5 sm:leading-7.5"
              defaultValue={defaultIntervalSeconds}
              id="monitor-interval"
              name="intervalSeconds"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 size-3 -translate-y-1/2 text-fg-3"
            />
          </span>
        </div>
      </div>

      {/* Code editor section. */}
      <div>
        <div className="mb-[7px] flex items-baseline justify-between">
          <FieldLabel className="mb-0">Browser check</FieldLabel>
          <span className="text-[11.5px] text-fg-3">
            A Playwright test, run on schedule. Use{" "}
            <span className="font-mono text-fg-2">expect</span> for hard checks;
            soft assertions surface as{" "}
            <span className="text-degraded">Degraded</span>.
          </span>
        </div>
        <CodeEditor
          aria-label="Browser check (Playwright source)"
          error={Boolean(error)}
          height={340}
          name="source"
          onValueChange={setSource}
          value={source}
        />
        <p className="mt-1.5 text-[11.5px] text-fg-3">
          Secrets like <span className="font-mono">process.env.SYNTH_USER</span>{" "}
          are injected from project settings.
        </p>
      </div>

      {/* Enabled toggle + actions. */}
      <div className="mt-0.5 flex items-center gap-3 border-t border-line-1 pt-4">
        <label className="flex cursor-pointer items-center gap-2.5">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
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

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-[30px] cursor-not-allowed items-center gap-1.5 rounded-[5px] px-[11px] text-[13px] text-fg-2 opacity-50"
            disabled
            title="Coming soon — dry-run your test before saving"
            type="button"
          >
            <Play className="size-3" />
            Run once
          </button>
          {cancelHref && (
            <a
              className="inline-flex h-[30px] items-center rounded-[5px] px-[11px] text-[13px] text-fg-2 transition-colors hover:bg-bg-2"
              href={cancelHref}
            >
              Cancel
            </a>
          )}
          <button
            className={cn(
              "inline-flex h-[30px] items-center rounded-[5px] border border-primary bg-primary px-[11px] text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90",
              limitReached && "pointer-events-none opacity-50",
            )}
            disabled={limitReached}
            type="submit"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Compact field label matching the design's `FieldLabel` (fg-2, 12px). */
function FieldLabel({
  children,
  className,
  htmlFor,
}: {
  children: React.ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <label
      className={cn("mb-1.5 block text-xs font-medium text-fg-2", className)}
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

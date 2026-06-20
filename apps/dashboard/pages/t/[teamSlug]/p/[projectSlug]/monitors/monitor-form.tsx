"use client";

import { Play } from "lucide-react";
import { Link } from "@void/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import {
  EnabledSwitchRow,
  FieldLabel,
  MonitorFormBanners,
  NativeSelect,
} from "./monitor-form-parts";
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
      <MonitorFormBanners error={error} limitReached={limitReached} />

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
          <NativeSelect
            defaultValue={defaultIntervalSeconds}
            id="monitor-interval"
            name="intervalSeconds"
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
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
        <EnabledSwitchRow enabled={enabled} onChange={setEnabled} />

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <Button
            disabled
            size="sm"
            title="Coming soon — dry-run your test before saving"
            variant="ghost"
          >
            <Play className="size-3" />
            Run once
          </Button>
          {cancelHref && (
            <Button
              render={<Link href={cancelHref} />}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          )}
          <Button disabled={limitReached} size="sm" type="submit">
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

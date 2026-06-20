"use client";

import { Plus, X } from "lucide-react";
import { Link } from "@void/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ALLOWED_COMPARISONS,
  ASSERTION_COMPARISONS,
  ASSERTION_SOURCES,
  type AssertionComparison,
  type AssertionSource,
  HTTP_MAX_ASSERTIONS,
  type HttpMonitorConfig,
} from "@/lib/monitors/monitor-schemas";
import {
  EnabledSwitchRow,
  FieldLabel,
  MonitorFormBanners,
  NativeSelect,
} from "./monitor-form-parts";
import { HTTP_INTERVAL_OPTIONS } from "./monitors-ui.shared";

/**
 * Create/edit form for an HTTP (uptime) monitor — the uptime sibling of
 * `MonitorForm`. A plain `<form method="post">` so the basic fields (URL,
 * interval, thresholds, switches) submit on the no-JS path; the one piece that
 * genuinely needs JS is the **assertion builder**, whose rows serialize into a
 * single hidden `assertions` JSON field — so adding/removing assertions is
 * interactive while the rest of the form stays a normal POST the server action
 * (`httpConfigFromForm`) reads field-by-field.
 *
 * `type=http` is posted as a hidden field so the action's discriminated-union
 * schema picks the http branch.
 */

/** UI-only assertion row (mirrors `AssertionSchema`'s input shape). */
interface AssertionRow {
  source: AssertionSource;
  property: string;
  comparison: AssertionComparison;
  target: string;
}

export interface HttpMonitorFormProps {
  /** Where the form POSTs. */
  action: string;
  submitLabel: string;
  error?: string | null;
  defaultName?: string;
  /** Existing config when editing; absent on create (fields fall to defaults). */
  defaultConfig?: HttpMonitorConfig;
  defaultIntervalSeconds?: number;
  defaultEnabled?: boolean;
  cancelHref?: string;
  limitReached?: boolean;
}

/** Human labels for the assertion vocabulary (kept terse + technical). */
const SOURCE_LABELS: Record<AssertionSource, string> = {
  STATUS_CODE: "Status code",
  RESPONSE_TIME: "Response time (ms)",
  HEADERS: "Header",
  TEXT_BODY: "Body (text)",
  JSON_BODY: "Body (JSON)",
};
const COMPARISON_LABELS: Record<AssertionComparison, string> = {
  EQUALS: "equals",
  NOT_EQUALS: "not equals",
  GREATER_THAN: "greater than",
  LESS_THAN: "less than",
  CONTAINS: "contains",
  NOT_CONTAINS: "not contains",
  IS_EMPTY: "is empty",
  NOT_EMPTY: "is not empty",
};
/** Sources whose `property` field (header name / JSON path) is shown. */
const NEEDS_PROPERTY = new Set<AssertionSource>(["HEADERS", "JSON_BODY"]);
/** Comparisons that take no target value. */
const NO_TARGET = new Set<AssertionComparison>(["IS_EMPTY", "NOT_EMPTY"]);

export function HttpMonitorForm({
  action,
  submitLabel,
  error,
  defaultName = "",
  defaultConfig,
  defaultIntervalSeconds = 300,
  defaultEnabled = true,
  cancelHref,
  limitReached = false,
}: HttpMonitorFormProps) {
  const [enabled, setEnabled] = useState(defaultEnabled);
  const [followRedirects, setFollowRedirects] = useState(
    defaultConfig?.followRedirects ?? true,
  );
  const [shouldFail, setShouldFail] = useState(
    defaultConfig?.shouldFail ?? false,
  );
  const [assertions, setAssertions] = useState<AssertionRow[]>(
    () =>
      defaultConfig?.assertions.map((a) => ({
        source: a.source,
        property: a.property ?? "",
        comparison: a.comparison,
        target: a.target,
      })) ?? [],
  );

  function updateAssertion(i: number, patch: Partial<AssertionRow>) {
    setAssertions((prev) =>
      prev.map((row, idx) => {
        if (idx !== i) return row;
        const next = { ...row, ...patch };
        // Changing the source can invalidate the comparison — snap it back to
        // the first comparison the new source allows.
        if (
          patch.source &&
          !ALLOWED_COMPARISONS[next.source].includes(next.comparison)
        ) {
          next.comparison = ALLOWED_COMPARISONS[next.source][0]!;
        }
        return next;
      }),
    );
  }

  function addAssertion() {
    setAssertions((prev) =>
      prev.length >= HTTP_MAX_ASSERTIONS
        ? prev
        : [
            ...prev,
            {
              source: "STATUS_CODE",
              property: "",
              comparison: "EQUALS",
              target: "200",
            },
          ],
    );
  }

  function removeAssertion(i: number) {
    setAssertions((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <form
      action={action}
      className="m-0 flex flex-col gap-[18px]"
      method="post"
    >
      <input name="type" type="hidden" value="http" />

      <MonitorFormBanners error={error} limitReached={limitReached} />

      {/* Name + interval. */}
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
            placeholder="Marketing site — homepage"
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
            {HTTP_INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {/* URL. */}
      <div>
        <FieldLabel htmlFor="monitor-url">URL</FieldLabel>
        <Input
          aria-invalid={error ? true : undefined}
          className="font-mono"
          defaultValue={defaultConfig?.url ?? ""}
          id="monitor-url"
          inputMode="url"
          maxLength={2048}
          name="url"
          nativeInput
          placeholder="https://example.com/health"
          required
          type="url"
        />
        <p className="mt-1.5 text-[11.5px] text-fg-3">
          A GET request runs on schedule. Private, loopback, and link-local
          addresses can&apos;t be monitored.
        </p>
      </div>

      {/* Response-time thresholds. */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <FieldLabel htmlFor="monitor-degraded">
            Degraded above (ms)
          </FieldLabel>
          <Input
            defaultValue={defaultConfig?.degradedResponseTimeMs ?? 3000}
            id="monitor-degraded"
            max={30000}
            min={1}
            name="degradedResponseTimeMs"
            nativeInput
            type="number"
          />
          <p className="mt-1.5 text-[11.5px] text-fg-3">
            Slower than this still passes, but as{" "}
            <span className="text-degraded">Degraded</span>.
          </p>
        </div>
        <div>
          <FieldLabel htmlFor="monitor-max">Fail above (ms)</FieldLabel>
          <Input
            defaultValue={defaultConfig?.maxResponseTimeMs ?? 5000}
            id="monitor-max"
            max={30000}
            min={1}
            name="maxResponseTimeMs"
            nativeInput
            type="number"
          />
          <p className="mt-1.5 text-[11.5px] text-fg-3">
            Slower than this is a <span className="text-fail">Fail</span>.
          </p>
        </div>
      </div>

      {/* Request switches. */}
      <div className="flex flex-col gap-3 rounded-lg border border-line-1 bg-bg-1 px-3.5 py-3">
        <SwitchRow
          checked={followRedirects}
          description="Follow 3xx redirects to the final response."
          label="Follow redirects"
          name="followRedirects"
          onChange={setFollowRedirects}
        />
        <SwitchRow
          checked={shouldFail}
          description="Expect a 4xx/5xx response — a 2xx/3xx becomes a Fail."
          label="This request should fail"
          name="shouldFail"
          onChange={setShouldFail}
        />
      </div>

      {/* Assertion builder. */}
      <div>
        <div className="mb-[7px] flex items-baseline justify-between">
          <FieldLabel className="mb-0">Assertions</FieldLabel>
          <span className="text-[11.5px] text-fg-3">
            Optional. All must pass. {assertions.length}/{HTTP_MAX_ASSERTIONS}
          </span>
        </div>
        {/* Serialized for the no-JS-friendly action: one hidden JSON field. */}
        <input
          name="assertions"
          type="hidden"
          value={JSON.stringify(
            assertions.map((a) => ({
              source: a.source,
              property: NEEDS_PROPERTY.has(a.source) ? a.property : undefined,
              comparison: a.comparison,
              target: NO_TARGET.has(a.comparison) ? "" : a.target,
            })),
          )}
        />
        <div className="flex flex-col gap-2">
          {assertions.length === 0 && (
            <p className="rounded-lg border border-dashed border-line-1 px-3.5 py-3 text-[12px] text-fg-3">
              No assertions — the check passes on a 2xx/3xx response within the
              response-time limit. Add one to assert on status, headers, or
              body.
            </p>
          )}
          {assertions.map((row, i) => (
            <AssertionRowEditor
              key={i}
              onChange={(patch) => updateAssertion(i, patch)}
              onRemove={() => removeAssertion(i)}
              row={row}
            />
          ))}
        </div>
        {assertions.length < HTTP_MAX_ASSERTIONS && (
          <Button
            className="mt-2"
            onClick={addAssertion}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3" />
            Add assertion
          </Button>
        )}
      </div>

      {/* Enabled toggle + actions. */}
      <div className="mt-0.5 flex items-center gap-3 border-t border-line-1 pt-4">
        <EnabledSwitchRow enabled={enabled} onChange={setEnabled} />

        <div className="flex-1" />

        <div className="flex items-center gap-2">
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

/** One assertion row: source · (property) · comparison · (target) · remove. */
function AssertionRowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: AssertionRow;
  onChange: (patch: Partial<AssertionRow>) => void;
  onRemove: () => void;
}) {
  const showProperty = NEEDS_PROPERTY.has(row.source);
  const showTarget = !NO_TARGET.has(row.comparison);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-1 bg-bg-1 px-2.5 py-2">
      <NativeSelect
        aria-label="Assertion source"
        className="w-[150px] shrink-0"
        onChange={(e) => {
          const source = ASSERTION_SOURCES.find(
            (s) => s === e.currentTarget.value,
          );
          if (source) onChange({ source });
        }}
        value={row.source}
      >
        {ASSERTION_SOURCES.map((s) => (
          <option key={s} value={s}>
            {SOURCE_LABELS[s]}
          </option>
        ))}
      </NativeSelect>

      {showProperty && (
        <Input
          aria-label={row.source === "HEADERS" ? "Header name" : "JSON path"}
          className="w-[130px] shrink-0 font-mono"
          nativeInput
          onChange={(e) => onChange({ property: e.currentTarget.value })}
          placeholder={row.source === "HEADERS" ? "content-type" : "$.data.id"}
          value={row.property}
        />
      )}

      <NativeSelect
        aria-label="Comparison"
        className="w-[140px] shrink-0"
        onChange={(e) => {
          const comparison = ASSERTION_COMPARISONS.find(
            (c) => c === e.currentTarget.value,
          );
          if (comparison) onChange({ comparison });
        }}
        value={row.comparison}
      >
        {ASSERTION_COMPARISONS.filter((cmp) =>
          ALLOWED_COMPARISONS[row.source].includes(cmp),
        ).map((cmp) => (
          <option key={cmp} value={cmp}>
            {COMPARISON_LABELS[cmp]}
          </option>
        ))}
      </NativeSelect>

      {showTarget && (
        <Input
          aria-label="Target value"
          className="min-w-0 flex-1 font-mono"
          nativeInput
          onChange={(e) => onChange({ target: e.currentTarget.value })}
          placeholder="value"
          value={row.target}
        />
      )}
      {!showTarget && <div className="flex-1" />}

      <button
        aria-label="Remove assertion"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-bg-3 hover:text-fail"
        onClick={onRemove}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** A switch + label/description row with a hidden form mirror when checked. */
function SwitchRow({
  name,
  label,
  description,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <Switch checked={checked} onCheckedChange={onChange} />
      {checked && <input name={name} type="hidden" value="on" />}
      <span>
        <span className="block text-[12.5px] font-medium text-foreground">
          {label}
        </span>
        <span className="block text-[11.5px] text-fg-3">{description}</span>
      </span>
    </label>
  );
}

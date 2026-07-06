"use client";

import { ChevronDown, X } from "lucide-react";
import { Link } from "@/components/ui/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { TcpMonitorConfig } from "@/lib/monitors/monitor-schemas";
import { cn } from "@/lib/cn";
import { HTTP_INTERVAL_OPTIONS } from "./monitors-ui.shared";

/**
 * Create/edit form for a TCP (port-connect) monitor — the raw-socket sibling of
 * `HttpMonitorForm`. A plain `<form method="post">` so every field submits on the
 * no-JS path; the only interactive leaf is the enabled `<Switch>`, which mirrors
 * into a hidden checkbox-style field the schema coerces. There is NO assertion
 * builder — a tcp check's only signal is "did the connection open within the
 * timeout", so it carries just host, port, and timeout.
 *
 * `type=tcp` is posted as a hidden field so the action's discriminated-union
 * schema picks the tcp branch. (A "ping" monitor is the same probe — Workers
 * can't send ICMP — so there is no separate ping form; the executor labels them.)
 */

export interface TcpMonitorFormProps {
  /** Where the form POSTs. */
  action: string;
  submitLabel: string;
  error?: string | null;
  defaultName?: string;
  /** Existing config when editing; absent on create (fields fall to defaults). */
  defaultConfig?: TcpMonitorConfig;
  defaultIntervalSeconds?: number;
  defaultEnabled?: boolean;
  cancelHref?: string;
  limitReached?: boolean;
  /**
   * Optional slot rendered just above the actions footer, inside the same
   * `<form>` — the edit surface passes the alert-recipient fields here so one
   * "Save changes" persists the config and its recipients together.
   */
  recipients?: React.ReactNode;
}

export function TcpMonitorForm({
  action,
  submitLabel,
  error,
  defaultName = "",
  defaultConfig,
  defaultIntervalSeconds = 300,
  defaultEnabled = true,
  cancelHref,
  limitReached = false,
  recipients,
}: TcpMonitorFormProps) {
  const [enabled, setEnabled] = useState(defaultEnabled);

  return (
    <form
      action={action}
      className="m-0 flex flex-col gap-[18px]"
      method="post"
    >
      <input name="type" type="hidden" value="tcp" />

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
            placeholder="Database — primary"
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

      {/* Host + port. */}
      <div className="grid grid-cols-[1fr_140px] gap-4">
        <div>
          <FieldLabel htmlFor="monitor-host">Host</FieldLabel>
          <Input
            aria-invalid={error ? true : undefined}
            className="font-mono"
            defaultValue={defaultConfig?.host ?? ""}
            id="monitor-host"
            maxLength={255}
            name="host"
            nativeInput
            placeholder="db.example.com"
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor="monitor-port">Port</FieldLabel>
          <Input
            aria-invalid={error ? true : undefined}
            className="font-mono"
            defaultValue={defaultConfig?.port ?? 443}
            id="monitor-port"
            max={65535}
            min={1}
            name="port"
            nativeInput
            required
            type="number"
          />
        </div>
      </div>
      <p className="-mt-2.5 text-[11.5px] text-fg-3">
        A TCP connection is opened on a schedule — the check passes when the
        port accepts the connection. Private, loopback, and link-local hosts
        can&apos;t be monitored. (Workers can&apos;t send ICMP, so this is also
        how &ldquo;ping&rdquo; reachability is measured.)
      </p>

      {/* Connect timeout. */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <FieldLabel htmlFor="monitor-timeout">
            Connect timeout (ms)
          </FieldLabel>
          <Input
            defaultValue={defaultConfig?.connectTimeoutMs ?? 5000}
            id="monitor-timeout"
            max={30000}
            min={1}
            name="connectTimeoutMs"
            nativeInput
            type="number"
          />
          <p className="mt-1.5 text-[11.5px] text-fg-3">
            Not connected within this is a{" "}
            <span className="text-fail">Fail</span>.
          </p>
        </div>
      </div>

      {recipients}

      {/* Enabled toggle + actions. */}
      <div className="mt-0.5 flex items-center gap-3 border-t border-line-1 pt-4">
        <label className="flex cursor-pointer items-center gap-2.5">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
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

/** Styled native `<select>` matching the http form's interval control. */
function NativeSelect({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span
      className={cn(
        "relative inline-flex rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24",
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

/** Compact field label matching the http form's `FieldLabel`. */
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
    <Label
      className={cn("mb-1.5 block text-xs text-fg-2 sm:text-xs", className)}
      htmlFor={htmlFor}
    >
      {children}
    </Label>
  );
}

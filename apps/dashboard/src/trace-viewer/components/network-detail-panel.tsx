"use client";

import { X } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/cn";
import { formatBytes, formatTraceDuration, prettyPrintJson } from "../format";
import { contentSha1, transferSize } from "../har-fields";
import type { TraceBridge } from "../use-trace-model";
import type { Timings } from "../vendor/har";
import type { ResourceEntry } from "../vendor/model-util";
import { BridgeBodyPreview } from "./body-preview";
import { GeneralRow, Section } from "./detail-shared";

/** Links each row's disclosure button (`aria-controls`) to the detail panel. */
export const DETAIL_PANEL_ID = "trace-network-request-details";

/** This tab's `Section` wrapper: bordered/padded rows, official-viewer parity. */
const NETWORK_SECTION_CLASSES =
  "flex flex-col gap-2 border-line-1 border-b px-3 py-3 last:border-b-0";

/** HAR timing phases, official-viewer waterfall order. */
const TIMING_PHASES: {
  key: keyof Timings;
  label: string;
  token: string;
}[] = [
  { key: "dns", label: "DNS", token: "bg-chart-1" },
  { key: "connect", label: "Connect", token: "bg-chart-2" },
  { key: "ssl", label: "SSL", token: "bg-chart-3" },
  { key: "send", label: "Send", token: "bg-chart-4" },
  { key: "wait", label: "Wait", token: "bg-chart-5" },
  { key: "receive", label: "Receive", token: "bg-ring" },
];

function GeneralSection({
  entry,
}: {
  entry: ResourceEntry;
}): React.ReactElement {
  const { request, response } = entry;
  const transfer = transferSize(response);
  return (
    <Section title="General" className={NETWORK_SECTION_CLASSES}>
      <div className="flex flex-col gap-2">
        <GeneralRow label="URL">
          <span className="break-all font-mono text-caption">
            {request.url}
          </span>
        </GeneralRow>
        <GeneralRow label="Method">
          <span className="font-mono text-caption">{request.method}</span>
        </GeneralRow>
        <GeneralRow label="Status">
          <span
            className={cn(
              "font-mono text-caption",
              response.status >= 400 && "text-fail",
            )}
          >
            {response.status || "—"} {response.statusText}
          </span>
        </GeneralRow>
        <GeneralRow label="Remote address">
          {entry.serverIPAddress ?? "—"}
        </GeneralRow>
        <GeneralRow label="Transfer size">
          {typeof transfer === "number" ? formatBytes(transfer) : "—"}
        </GeneralRow>
        <GeneralRow label="Content size">
          {formatBytes(response.content.size)}
        </GeneralRow>
        <GeneralRow label="Duration">
          {formatTraceDuration(entry.time)}
        </GeneralRow>
      </div>
    </Section>
  );
}

/** Stacked timing bar + per-phase legend, skipping unset/-1 phases. */
function TimingSection({ timings }: { timings: Timings }): React.ReactElement {
  const phases = TIMING_PHASES.map((phase) => ({
    ...phase,
    value: timings[phase.key],
  })).filter(
    (phase): phase is (typeof TIMING_PHASES)[number] & { value: number } =>
      typeof phase.value === "number" && phase.value >= 0,
  );
  const total = phases.reduce((sum, phase) => sum + phase.value, 0);

  return (
    <Section title="Timing" className={NETWORK_SECTION_CLASSES}>
      {phases.length === 0 || total <= 0 ? (
        <div className="text-caption text-fg-4">No timing data.</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-2">
            {phases.map((phase) => (
              <div
                key={phase.key}
                className={phase.token}
                style={{ width: `${(phase.value / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {phases.map((phase) => (
              <div
                key={phase.key}
                className="flex items-center gap-1.5 text-micro text-fg-3"
              >
                <span
                  className={cn("size-2 shrink-0 rounded-full", phase.token)}
                />
                {phase.label} {phase.value.toFixed(1)}ms
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function HeaderRows({
  headers,
}: {
  headers: { name: string; value: string }[];
}): React.ReactElement {
  if (headers.length === 0) {
    return <div className="text-caption text-fg-4">None</div>;
  }
  return (
    <div className="flex flex-col gap-0.5 font-mono text-caption">
      {headers.map((header, i) => (
        <div key={`${header.name}-${i}`} className="break-all">
          <span className="text-fg-3">{header.name}: </span>
          <span>{header.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The split-out request detail panel (official-viewer parity: general / timing
 * / headers / bodies). Its only inputs are the selected `entry` + the bridge
 * bits its response-body preview needs, so it lives apart from the table.
 */
export function DetailPanel({
  entry,
  bridge,
  onClose,
}: {
  entry: ResourceEntry;
  bridge: TraceBridge;
  onClose: () => void;
}): React.ReactElement {
  const postData = entry.request.postData;
  const responseSha1 = contentSha1(entry.response.content);

  return (
    <div
      id={DETAIL_PANEL_ID}
      className="flex h-full min-h-0 flex-col border-line-1 border-t sm:border-t-0 sm:border-l"
    >
      <div className="flex shrink-0 items-center gap-2 border-line-1 border-b px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-caption"
          title={entry.request.url}
        >
          {entry.request.url}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Close request details"
        >
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col">
          <GeneralSection entry={entry} />
          <TimingSection timings={entry.timings} />
          <Section title="Request headers" className={NETWORK_SECTION_CLASSES}>
            <HeaderRows headers={entry.request.headers} />
          </Section>
          <Section title="Response headers" className={NETWORK_SECTION_CLASSES}>
            <HeaderRows headers={entry.response.headers} />
          </Section>
          {postData?.text ? (
            <Section title="Request body" className={NETWORK_SECTION_CLASSES}>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-caption">
                {prettyPrintJson(postData.text, postData.mimeType)}
              </pre>
            </Section>
          ) : null}
          {responseSha1 ? (
            <Section title="Response body" className={NETWORK_SECTION_CLASSES}>
              <BridgeBodyPreview
                sha1={responseSha1}
                mimeType={entry.response.content.mimeType}
                size={entry.response.content.size}
                bridge={bridge}
              />
            </Section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

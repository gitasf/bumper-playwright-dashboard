"use client";

import type React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTraceDuration, formatWallClock } from "../format";
import type { TraceModel } from "../vendor/model-util";
import { Field } from "./detail-shared";

/** Trace/context metadata as a dense two-column definition grid. Every value is
 * plain prose (`variant="plain"`), unlike Call's monospace fields. */
export function MetadataTab({
  model,
}: {
  model: TraceModel;
}): React.ReactElement {
  const browser =
    [model.browserName, model.channel].filter(Boolean).join(" / ") || "—";
  const viewport = model.options.viewport
    ? `${model.options.viewport.width}×${model.options.viewport.height}`
    : "—";
  const started = model.wallTime
    ? formatWallClock(model.wallTime, { withDate: true })
    : "—";

  return (
    <ScrollArea className="h-full">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 px-4 py-3">
        <Field variant="plain" label="Browser" value={browser} />
        <Field variant="plain" label="Platform" value={model.platform || "—"} />
        <Field
          variant="plain"
          label="Playwright version"
          value={model.playwrightVersion || "—"}
        />
        <Field
          variant="plain"
          label="SDK language"
          value={model.sdkLanguage || "—"}
        />
        <Field variant="plain" label="Viewport" value={viewport} />
        <Field
          variant="plain"
          label="Test ID attribute"
          value={model.testIdAttributeName || "—"}
        />
        <Field variant="plain" label="Started" value={started} />
        <Field
          variant="plain"
          label="Duration"
          value={formatTraceDuration(model.endTime - model.startTime)}
        />
        <Field variant="plain" label="Pages" value={model.pages.length} />
        <Field
          variant="plain"
          label="Timeout"
          value={model.testTimeout ? `${model.testTimeout}ms` : "—"}
        />
      </dl>
    </ScrollArea>
  );
}

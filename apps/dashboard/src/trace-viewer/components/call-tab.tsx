"use client";

import type React from "react";
import { AnsiPre } from "@/components/ansi-pre";
import {
  formatJsonRecordPreview,
  formatJsonValuePreview,
  formatTraceDuration,
  formatTraceOffset,
  formatWallClock,
} from "../format";
import { actionTitle } from "../model";
import type {
  ActionTraceEventInContext,
  TraceModel,
} from "../vendor/model-util";
import { Field, Section, TabNotice } from "./detail-shared";

/** Compact JSON preview: single-line for primitives, pretty + bounded for objects. */
function renderJsonPreview(
  preview: string,
  objectLike: boolean,
): React.ReactElement {
  if (!objectLike) {
    return (
      <span className="break-words font-mono text-caption">{preview}</span>
    );
  }
  return (
    <pre className="max-h-40 overflow-auto break-words font-mono text-caption">
      {preview}
    </pre>
  );
}

function renderJsonValue(value: unknown): React.ReactElement {
  return renderJsonPreview(
    formatJsonValuePreview(value),
    typeof value === "object" && value !== null,
  );
}

function isNonEmptyResult(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== null && typeof value === "object") {
    // Stop at the first own enumerable property. `Object.keys` materializes
    // every key before the bounded preview formatter gets a chance to cap the
    // trace value, which can freeze the Call tab on a huge return object.
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    }
    return false;
  }
  return true;
}

/** The "Call" detail tab: parameters, return value, timing and error for the
 * hover-aware active action. */
export function CallTab({
  model,
  activeAction,
}: {
  model: TraceModel;
  activeAction: ActionTraceEventInContext | undefined;
}): React.ReactElement {
  if (!activeAction) {
    return <TabNotice>Select an action to see its call details.</TabNotice>;
  }

  const action = activeAction;
  const params: Record<string, unknown> = action.params ?? {};
  const paramPreview = formatJsonRecordPreview(params);
  const hasResult = isNonEmptyResult(action.result);
  const errorMessage = action.error?.message;

  const wallClock =
    model.wallTime !== undefined
      ? formatWallClock(model.wallTime + (action.startTime - model.startTime))
      : undefined;

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="flex flex-col gap-4 px-3 py-3">
        <div className="flex flex-col gap-3">
          <div className="font-mono text-body font-medium text-fg-2">
            {actionTitle(action)}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5">
            <Field
              label="Start"
              value={
                wallClock
                  ? `${formatTraceOffset(action.startTime, model.startTime)} (${wallClock})`
                  : formatTraceOffset(action.startTime, model.startTime)
              }
            />
            <Field
              label="Duration"
              value={formatTraceDuration(action.endTime - action.startTime)}
            />
            <Field label="Page" value={action.pageId ?? "—"} />
            <Field label="Call id" value={action.callId} />
          </dl>
        </div>

        {paramPreview.entries.length > 0 ? (
          <Section title="Parameters">
            <dl className="flex flex-col gap-2">
              {paramPreview.entries.map((entry, index) => (
                // `bare`: the preview brings its own mono/size classes.
                <Field
                  key={`${index}:${entry.label}`}
                  label={entry.label}
                  value={renderJsonPreview(entry.preview, entry.objectLike)}
                  variant="bare"
                />
              ))}
            </dl>
            {paramPreview.truncated ? (
              <div className="mt-2 text-caption text-fg-4">
                Additional parameters omitted.
              </div>
            ) : null}
          </Section>
        ) : null}

        {hasResult ? (
          <Section title="Return value">
            {renderJsonValue(action.result)}
          </Section>
        ) : null}

        {errorMessage ? (
          <Section title="Error">
            <AnsiPre text={errorMessage} className="text-caption" />
          </Section>
        ) : null}
      </div>
    </div>
  );
}

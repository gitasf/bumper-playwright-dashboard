"use client";

import type React from "react";
import { AnsiPre } from "@/components/ansi-pre";
import {
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

/** Compact JSON preview: single-line for primitives, pretty + capped for objects. */
function renderJsonValue(value: unknown): React.ReactElement {
  const isObjectLike = typeof value === "object" && value !== null;
  if (!isObjectLike) {
    return (
      <span className="break-words font-mono text-caption">
        {JSON.stringify(value)}
      </span>
    );
  }
  return (
    <pre className="max-h-40 overflow-auto break-words font-mono text-caption">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function isNonEmptyResult(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
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
  const paramEntries = Object.entries(params);
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

        {paramEntries.length > 0 ? (
          <Section title="Parameters">
            <dl className="flex flex-col gap-2">
              {paramEntries.map(([key, value]) => (
                // `bare`: renderJsonValue brings its own mono/size classes.
                <Field
                  key={key}
                  label={key}
                  value={renderJsonValue(value)}
                  variant="bare"
                />
              ))}
            </dl>
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

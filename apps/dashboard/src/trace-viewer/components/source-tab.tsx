"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { basename } from "@/lib/basename";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { isRealSourceFile, sha1Path } from "../model";
import { pickDefaultFile, sha1Hex, tokenizeSource } from "../source-highlight";
import { useBridgeFetch } from "../use-bridge-fetch";
import type { TraceBridge } from "../use-trace-model";
import type {
  ActionTraceEventInContext,
  TraceModel,
} from "../vendor/model-util";
import type { StackFrame } from "../vendor/protocol-types";
import { TabNotice } from "./detail-shared";

/**
 * Read-only source view for the hover-aware active action's stack frame
 * (`activeAction`), with a stack frame picker
 * alongside it. Keyed on `activeAction` by `DetailTabs`, so a change remounts
 * it (fresh default file + frame index) instead of reconciling stale manual
 * picks against a new stack.
 */
export function SourceTab({
  model,
  activeAction,
  bridge,
}: {
  model: TraceModel;
  activeAction: ActionTraceEventInContext | undefined;
  bridge: TraceBridge;
}): React.ReactElement {
  const traceUrl = bridge.traceUrl;
  const files = Array.from(model.sources.keys()).filter(isRealSourceFile);
  const [manualFile, setManualFile] = useState<string | undefined>(undefined);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);

  const stack = activeAction?.stack ?? [];
  const selectedFrame = stack[selectedFrameIndex];

  const file = manualFile ?? pickDefaultFile(selectedFrame, model.sources);
  const source = file ? model.sources.get(file) : undefined;

  // Fetch keyed on `traceUrl` + `file` (mirroring `snapshotInfoKey` in
  // snapshot-pane.tsx), so a file switch can never render the previous
  // file's text under the new file's tab/dialect/error lines, AND an
  // attempt swap (same file path, different trace) can never serve the
  // prior trace's cached text — the loader below reads both `traceUrl` and
  // `file`, and useBridgeFetch only ever refetches on a key change. The
  // fetched text is cached on the shared model (mirroring the upstream
  // viewer's lazy-fill of `SourceModel.content`), so later tab visits skip
  // the fetch.
  const needsFetch = source !== undefined && source.content === undefined;
  const fetched = useBridgeFetch(
    bridge,
    needsFetch && file ? `${traceUrl}#${file}` : null,
    async () => {
      if (!file) throw new Error("Source view is not available yet.");
      const sha1 = await sha1Hex(file);
      const blob = await bridge.fetchBlob(
        sha1Path(traceUrl, `src@${sha1}.txt`),
      );
      const text = await blob.text();
      const cached = model.sources.get(file);
      if (cached) cached.content = text;
      return text;
    },
  );
  const content = source?.content ?? fetched.value;
  const fetchError = fetched.error?.message;

  if (files.length === 0 || !file) {
    return <TabNotice>Source view is not available yet.</TabNotice>;
  }

  const targetLine =
    selectedFrame && selectedFrame.file === file
      ? selectedFrame.line
      : source?.errors[0]?.line;
  const errors = source?.errors ?? [];

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {files.length > 1 ? (
          <TabBar className="shrink-0 px-2" role="tablist" scrollable>
            {files.map((f) => (
              <span key={f} title={f}>
                <TabBarTab
                  active={f === file}
                  onSelect={() => setManualFile(f)}
                >
                  {basename(f)}
                </TabBarTab>
              </span>
            ))}
          </TabBar>
        ) : (
          <div
            className="shrink-0 truncate border-b border-line-1 px-3 py-1.5 text-caption text-fg-3"
            title={file}
          >
            {basename(file)}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {fetchError ? (
            <div className="px-3 py-2 text-caption text-fg-4">{fetchError}</div>
          ) : content === undefined ? null : (
            <SourceLines
              content={content}
              errors={errors}
              file={file}
              targetLine={targetLine}
            />
          )}
        </div>
      </div>
      {stack.length > 0 ? (
        <FrameList
          frames={stack}
          onSelect={(index) => {
            setSelectedFrameIndex(index);
            setManualFile(undefined);
          }}
          selectedIndex={selectedFrameIndex}
          sources={model.sources}
        />
      ) : null}
    </div>
  );
}

/**
 * Right-hand stack frame picker (~35% width, own scroll region). Clicking an
 * enabled frame switches the displayed file to that frame's file and
 * scroll-highlights its line (via `targetLine` in the parent, which is driven
 * by the selected frame). Frames whose file never made it into
 * `model.sources` (e.g. library-internal frames the trace didn't capture
 * source for), or whose file is a Playwright-synthesized non-file location
 * (`isRealSourceFile`), render disabled.
 */
function FrameList({
  frames,
  selectedIndex,
  sources,
  onSelect,
}: {
  frames: StackFrame[];
  selectedIndex: number;
  sources: TraceModel["sources"];
  onSelect: (index: number) => void;
}): React.ReactElement {
  return (
    <div
      className="w-[35%] min-w-[160px] shrink-0 overflow-y-auto border-l border-line-1"
      role="list"
    >
      {frames.map((frame, index) => {
        const available =
          isRealSourceFile(frame.file) && sources.has(frame.file);
        const active = index === selectedIndex;
        return (
          <button
            className={cn(
              "flex w-full flex-col items-start gap-0.5 border-b border-line-1 px-3 py-1.5 text-left",
              available ? "cursor-pointer hover:bg-bg-2" : "cursor-default",
              active && available && "bg-bg-2",
            )}
            disabled={!available}
            key={`${frame.file}:${frame.line}:${index}`}
            onClick={() => onSelect(index)}
            title={frame.file}
            type="button"
          >
            <span
              className={cn(
                "truncate text-caption",
                available ? "text-fg-3" : "text-fg-4",
              )}
            >
              {frame.function || "(anonymous)"}
            </span>
            <span
              className={cn(
                "truncate font-mono text-caption",
                available ? "text-fg-2" : "text-fg-4",
              )}
            >
              {basename(frame.file)}:{frame.line}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Line-numbered `<pre>` renderer: target line highlighted + scrolled into
 * view, error lines tinted with their message inline beneath. Line text is
 * tokenized with pure `@lezer/javascript` + `@lezer/highlight`
 * (`tokenizeSource` above) rather than CodeMirror — a CodeMirror
 * (`@uiw/react-codemirror`) variant was attempted and REVERTED: custom
 * decoration extensions built outside the wrapper hit "multiple instances
 * of @codemirror/state" under Vite dev pre-bundling (instanceof breakage),
 * silently falling back anyway. The lezer parser/highlighter packages used
 * here never touch `@codemirror/state`, so that dedupe failure mode doesn't
 * apply — no `<CodeMirror>` element is ever mounted for this tab.
 */
function SourceLines({
  content,
  errors,
  file,
  targetLine,
}: {
  content: string;
  errors: { line: number; message: string }[];
  file: string;
  targetLine: number | undefined;
}): React.ReactElement {
  const lines = content.split("\n");
  const tokenLines = useMemo(
    () => tokenizeSource(content, file),
    [content, file],
  );
  const errorsByLine = new Map<number, string>();
  for (const error of errors) errorsByLine.set(error.line, error.message);
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [targetLine, content]);

  return (
    <pre className="trace-source min-w-max py-1 font-mono text-body leading-5">
      {lines.map((line, i) => {
        const lineNumber = i + 1;
        const isTarget = lineNumber === targetLine;
        const errorMessage = errorsByLine.get(lineNumber);
        const tokenLine = tokenLines?.[i];
        return (
          <div key={lineNumber}>
            <div
              className={cn(
                "flex gap-3 px-3",
                // Inset accent bar (not border-l) so the highlight doesn't
                // shift the line's flex content. Error tint takes priority
                // over the target tint when a line is both.
                isTarget &&
                  "bg-running-soft shadow-[inset_2px_0_0_var(--color-running)]",
                errorMessage && "bg-fail-soft",
              )}
              data-current-line={isTarget ? "true" : undefined}
              ref={isTarget ? targetRef : undefined}
            >
              <span
                className="w-8 shrink-0 select-none text-right tabular-nums text-fg-4"
                data-line-number={lineNumber}
              >
                {lineNumber}
              </span>
              <span className="whitespace-pre">
                {tokenLine
                  ? tokenLine.length > 0
                    ? tokenLine.map((segment, segmentIndex) => (
                        <span className={segment.className} key={segmentIndex}>
                          {segment.text}
                        </span>
                      ))
                    : " "
                  : line || " "}
              </span>
            </div>
            {errorMessage ? (
              <div className="ml-11 whitespace-pre-wrap break-words px-3 py-1 text-caption text-fail">
                {errorMessage}
              </div>
            ) : null}
          </div>
        );
      })}
    </pre>
  );
}

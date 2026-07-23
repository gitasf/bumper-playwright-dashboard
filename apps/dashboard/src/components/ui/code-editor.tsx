"use client";

import { SquareCode } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { DeferErrorBoundary } from "@/components/defer-error-boundary";
import { cn } from "@/lib/cn";

/**
 * The CodeMirror editor body is heavy (~180 KB gzipped with the JS grammar) and
 * only the editable, hydrated path ever renders it — so it lives in its own
 * module and is lazy-loaded on demand. `readOnly` editors (e.g. the monitor
 * detail page's "Test definition" view) and the monitors list page never fetch
 * the chunk; the create/edit form pulls it in only once the editor mounts.
 */
const CodeMirrorField = lazy(() => import("./code-editor-codemirror"));

/**
 * Controlled code editor island for the monitor Playwright source.
 *
 * Submits as part of a plain `<form method="post">` by writing its value into a
 * hidden field named `name` (default `"source"`) — so it works identically on
 * the no-JS slow path and the SPA-action fast path the create/edit pages use,
 * with no client fetch wiring.
 *
 * SSR guard: CodeMirror reaches for `document`/`window` at module-eval and
 * mount, which would crash the Worker's server render. We therefore render a
 * monospace `<textarea>` (also `name`d, so the form is fully functional even
 * before/without hydration) on the server and for the first client paint, then
 * swap to CodeMirror once a `mounted` flag flips in an effect. It's also the
 * `Suspense` fallback while the lazy CodeMirror chunk loads. The hidden input
 * mirrors the controlled value so whichever editor is showing, the submitted
 * field is always current.
 *
 * Chrome: the surface is dressed like the design's editor — a `bg-1` toolbar
 * bar (filename + language pill + line count) above a `bg-0` editor body, with
 * an `error` border treatment. A textarea fallback fakes a line-number gutter
 * so the pre-hydration / read-only paint already reads like a code surface.
 */
export interface CodeEditorProps {
  /** Controlled source text. */
  value: string;
  onValueChange: (next: string) => void;
  /** Hidden form field name the value submits under. */
  name?: string;
  /** Visible height of the editor surface. */
  height?: number | string;
  className?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Apply the invalid border treatment (validation failed upstream). */
  error?: boolean;
  "aria-label"?: string;
}

export function CodeEditor({
  value,
  onValueChange,
  name = "source",
  height = 360,
  className,
  placeholder,
  readOnly = false,
  error = false,
  "aria-label": ariaLabel = "Playwright source",
}: CodeEditorProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const heightStyle = typeof height === "number" ? `${height}px` : height;
  const lineCount = value.length === 0 ? 1 : value.split("\n").length;

  const fallback = (
    <EditorFallback
      ariaLabel={ariaLabel}
      heightStyle={heightStyle}
      lineCount={lineCount}
      onValueChange={onValueChange}
      placeholder={placeholder}
      readOnly={readOnly}
      value={value}
    />
  );

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-bg-0 text-sm shadow-xs/5 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24",
        error ? "border-fail/50" : "border-input",
        className,
      )}
      data-slot="code-editor"
    >
      {/* The submitted field — always present, mirrors the controlled value so
       * SSR, pre-hydration, and the CodeMirror path all post the same source. */}
      <input name={name} type="hidden" value={value} />

      {/* Toolbar: filename, language pill, read-only tag, line count. */}
      <div className="flex items-center gap-2 border-b border-line-1 bg-bg-1 px-3 py-2">
        <SquareCode aria-hidden="true" className="size-3 text-fg-3" />
        <span className="font-mono text-caption text-fg-2">
          monitor.spec.ts
        </span>
        <span className="rounded-[4px] bg-bg-3 px-1.5 py-px font-mono text-micro uppercase tracking-[0.4px] text-fg-3">
          TypeScript
        </span>
        {readOnly && <span className="text-micro text-fg-4">read-only</span>}
        <div className="flex-1" />
        <span className="font-mono text-micro text-fg-4">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
      </div>

      {/* Editor body — lazy CodeMirror once hydrated + editable, else the
       * gutter-faking textarea (also the Suspense fallback during chunk load). */}
      <div className="bg-bg-0">
        {mounted && !readOnly ? (
          // Error boundary: if the lazy CodeMirror chunk fails to load (e.g. a
          // hashed filename 404 after a redeploy while this tab was open), fall
          // back to the fully-functional textarea instead of throwing past
          // Suspense and blanking the form.
          <DeferErrorBoundary fallback={fallback}>
            <Suspense fallback={fallback}>
              <CodeMirrorField
                aria-label={ariaLabel}
                height={heightStyle}
                onValueChange={onValueChange}
                placeholder={placeholder}
                value={value}
              />
            </Suspense>
          </DeferErrorBoundary>
        ) : (
          fallback
        )}
      </div>
    </div>
  );
}

/**
 * Gutter-faking `<textarea>` — the SSR / pre-hydration / read-only view AND the
 * `Suspense` fallback while the CodeMirror chunk loads. Fully functional (mirrors
 * into the controlled value), so the form works even before the editor swaps in.
 */
function EditorFallback({
  value,
  onValueChange,
  lineCount,
  heightStyle,
  placeholder,
  readOnly,
  ariaLabel,
}: {
  value: string;
  onValueChange: (next: string) => void;
  lineCount: number;
  heightStyle: string;
  placeholder?: string;
  readOnly: boolean;
  ariaLabel: string;
}) {
  return (
    <div className="flex" style={{ height: heightStyle }}>
      {/* Line-number gutter feel. */}
      <div
        aria-hidden="true"
        className="shrink-0 select-none overflow-hidden border-r border-line-1 bg-bg-1 py-3 text-right font-mono text-body leading-5 text-fg-4"
        style={{ width: 46 }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div className="px-2.5" key={i}>
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        aria-label={ariaLabel}
        className="block min-w-0 flex-1 resize-none whitespace-pre bg-transparent px-3.5 py-3 font-mono text-body leading-5 text-fg-1 outline-none placeholder:text-muted-foreground/72"
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

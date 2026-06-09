"use client";

import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import { SquareCode } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

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
 * swap to CodeMirror once a `mounted` flag flips in an effect. The hidden input
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
        <span className="font-mono text-[11.5px] text-fg-2">
          monitor.spec.ts
        </span>
        <span className="rounded-[4px] bg-bg-3 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.4px] text-fg-3">
          TypeScript
        </span>
        {readOnly && <span className="text-[11px] text-fg-4">read-only</span>}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-fg-4">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
      </div>

      {/* Editor body — CodeMirror once hydrated, else a gutter-faking textarea. */}
      <div className="bg-bg-0">
        {mounted && !readOnly ? (
          <CodeMirror
            aria-label={ariaLabel}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: false,
              autocompletion: false,
            }}
            extensions={[javascript({ jsx: false, typescript: true })]}
            height={heightStyle}
            onChange={onValueChange}
            placeholder={placeholder}
            style={{ background: "transparent" }}
            theme="none"
            value={value}
          />
        ) : (
          <div className="flex" style={{ height: heightStyle }}>
            {/* Line-number gutter feel. */}
            <div
              aria-hidden="true"
              className="shrink-0 select-none overflow-hidden border-r border-line-1 bg-bg-1 py-3 text-right font-mono text-[12.5px] leading-5 text-fg-4"
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
              className="block min-w-0 flex-1 resize-none whitespace-pre bg-transparent px-3.5 py-3 font-mono text-[12.5px] leading-5 text-fg-1 outline-none placeholder:text-muted-foreground/72"
              onChange={(e) => onValueChange(e.target.value)}
              placeholder={placeholder}
              readOnly={readOnly}
              spellCheck={false}
              value={value}
            />
          </div>
        )}
      </div>
    </div>
  );
}

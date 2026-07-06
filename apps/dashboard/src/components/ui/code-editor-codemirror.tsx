"use client";

import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";

export interface CodeMirrorFieldProps {
  value: string;
  onValueChange: (next: string) => void;
  /** Resolved CSS height (e.g. `"340px"`). */
  height: string;
  placeholder?: string;
  "aria-label"?: string;
}

/**
 * The CodeMirror editor body, split into its own module so {@link CodeEditor}
 * (`./code-editor`) can `React.lazy` it. CodeMirror + the JS-language grammar
 * are ~180 KB gzipped and only the editable (hydrated, non-`readOnly`) path
 * renders them — so they load on demand instead of shipping in the monitor
 * pages' first-load bundle. `readOnly` editors and the monitors list page never
 * fetch this chunk.
 *
 * Default export so `lazy(() => import("./code-editor-codemirror"))` resolves it
 * directly.
 */
export default function CodeMirrorField({
  value,
  onValueChange,
  height,
  placeholder,
  "aria-label": ariaLabel,
}: CodeMirrorFieldProps) {
  return (
    <CodeMirror
      aria-label={ariaLabel}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        foldGutter: false,
        autocompletion: false,
      }}
      extensions={[javascript({ jsx: false, typescript: true })]}
      height={height}
      onChange={onValueChange}
      placeholder={placeholder}
      style={{ background: "transparent" }}
      theme="none"
      value={value}
    />
  );
}

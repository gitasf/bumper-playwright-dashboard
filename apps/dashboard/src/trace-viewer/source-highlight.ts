import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { basename } from "@/lib/basename";
import { isRealSourceFile } from "./model";
import type { TraceModel } from "./vendor/model-util";
import type { StackFrame } from "./vendor/protocol-types";

/**
 * Playwright's own viewer resolves a stack frame's `file` to a trace resource
 * at `sha1/src@<sha1>.txt` where `<sha1>` is the SHA-1 (lower hex) of the RAW
 * `file` string itself — no path normalization. Verified against
 * microsoft/playwright tag v1.61.1,
 * packages/trace-viewer/src/ui/sourceTab.tsx (`calculateSha1` + its call site
 * in `useSources`), and empirically: sha1 of
 * "/tmp/pw-trace-test/tests/probe2.spec.ts" (the spec path recorded in that
 * trace's `0-trace.stacks`) equals `bf45fd7c3d5318ab34731eab199ac8d9f8c4a271`,
 * the exact resource file the trace shipped as `src@....txt`.
 */
export async function sha1Hex(text: string): Promise<string> {
  const buffer = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Default file: the selected frame's file, else the first file carrying an
 * error, else whichever file the model saw first. Never picks a synthetic
 * (non-real) file — e.g. Playwright's `project#<id>` fixture-pool location —
 * even when it's the only source the model recorded. */
export function pickDefaultFile(
  frame: StackFrame | undefined,
  sources: TraceModel["sources"],
): string | undefined {
  if (frame && isRealSourceFile(frame.file) && sources.has(frame.file)) {
    return frame.file;
  }
  for (const [file, source] of sources) {
    if (isRealSourceFile(file) && source.errors.length > 0) return file;
  }
  for (const file of sources.keys()) {
    if (isRealSourceFile(file)) return file;
  }
  return undefined;
}

export type TokenSegment = { text: string; className: string | undefined };

/** File extensions `@lezer/javascript` can parse, and the dialect flags each
 * one needs (mirrors `@codemirror/lang-javascript`'s own `configure` calls —
 * see node_modules/@codemirror/lang-javascript/dist/index.js). Anything else
 * (`.py`, `.json`, `.css`, …) falls back to unhighlighted text rather than
 * risk running the JS/TS grammar over the wrong language. */
const JS_TS_DIALECTS: Record<string, string | undefined> = {
  js: undefined,
  mjs: undefined,
  cjs: undefined,
  jsx: "jsx",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "ts jsx",
};

export function fileExtension(file: string): string | undefined {
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? undefined : base.slice(dot + 1).toLowerCase();
}

/**
 * Tokenize `content` into `tok-*`-classed segments, one array per line
 * (mirroring `content.split("\n")`'s line count exactly, since
 * `highlightCode`'s `putBreak` fires once per `\n` and never bundles a
 * break into a text chunk). Returns `undefined` for extensions outside the
 * JS/TS family — callers should render plain text in that case rather than
 * run the wrong grammar over it.
 */
export function tokenizeSource(
  content: string,
  file: string,
): TokenSegment[][] | undefined {
  const ext = fileExtension(file);
  if (ext === undefined || !(ext in JS_TS_DIALECTS)) return undefined;
  const dialect = JS_TS_DIALECTS[ext];
  try {
    const langParser = dialect ? jsParser.configure({ dialect }) : jsParser;
    const tree = langParser.parse(content);
    const lines: TokenSegment[][] = [[]];
    highlightCode(
      content,
      tree,
      classHighlighter,
      (text, classes) => {
        lines[lines.length - 1]?.push({
          text,
          className: classes || undefined,
        });
      },
      () => {
        lines.push([]);
      },
    );
    return lines;
  } catch {
    // Malformed/unexpected content — fall back to plain text rather than
    // surface a parser error in a read-only source view.
    return undefined;
  }
}

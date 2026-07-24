import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  fileExtension,
  pickDefaultFile,
  sha1Hex,
  tokenizeSource,
} from "@/trace-viewer/source-highlight";
import type { SourceModel } from "@/trace-viewer/vendor/model-util";
import type { StackFrame } from "@/trace-viewer/vendor/protocol-types";

/**
 * Unit tests for the pure logic behind the Source tab (extracted from
 * source-tab.tsx): the sha1 resource-path digest, default-file selection,
 * and the `@lezer/javascript` tokenizer's line-count invariant + dialect
 * fallback.
 */

function frame(file: string, over: Partial<StackFrame> = {}): StackFrame {
  return { file, line: 1, column: 1, ...over };
}

function sourceModel(over: Partial<SourceModel> = {}): SourceModel {
  return { errors: [], content: undefined, ...over };
}

describe("sha1Hex", () => {
  it("matches SHA-1 of the raw file path (Playwright's src@<sha1>.txt resource contract)", async () => {
    // Known vector recorded in the SourceTab sha1Hex docstring: the exact
    // spec path a real trace's `0-trace.stacks` recorded, and the exact
    // `src@....txt` resource file that trace shipped.
    const path = "/tmp/pw-trace-test/tests/probe2.spec.ts";
    const expected = "bf45fd7c3d5318ab34731eab199ac8d9f8c4a271";
    expect(createHash("sha1").update(path).digest("hex")).toBe(expected);
    expect(await sha1Hex(path)).toBe(expected);
  });

  it("matches node:crypto SHA-1 for an arbitrary path", async () => {
    const path = "/repo/tests/checkout.spec.ts";
    expect(await sha1Hex(path)).toBe(
      createHash("sha1").update(path).digest("hex"),
    );
  });
});

describe("fileExtension", () => {
  it.each([
    ["/repo/tests/checkout.spec.ts", "ts"],
    ["/repo/scripts/gen.py", "py"],
    ["helpers.MJS", "mjs"],
    ["/repo/README", undefined],
    ["/repo/.env", "env"],
    ["C:\\repo\\tests\\checkout.spec.ts", "ts"],
  ])("fileExtension(%s) -> %s", (file, expected) => {
    expect(fileExtension(file)).toBe(expected);
  });
});

describe("pickDefaultFile", () => {
  const specFile = "/repo/tests/checkout.spec.ts";
  const helpersFile = "/repo/tests/helpers.ts";
  const syntheticFile = "project#abc123";

  it("picks the selected frame's file when it's real and in sources", () => {
    const sources = new Map([
      [specFile, sourceModel()],
      [helpersFile, sourceModel()],
    ]);
    expect(pickDefaultFile(frame(specFile), sources)).toBe(specFile);
  });

  it("ignores a synthetic (non-real) frame file and falls through", () => {
    const sources = new Map([[specFile, sourceModel()]]);
    expect(pickDefaultFile(frame(syntheticFile), sources)).toBe(specFile);
  });

  it("ignores a frame file that never made it into sources", () => {
    const sources = new Map([[helpersFile, sourceModel()]]);
    expect(pickDefaultFile(frame(specFile), sources)).toBe(helpersFile);
  });

  it("prefers the first real file carrying an error when no frame is given", () => {
    const sources = new Map([
      [helpersFile, sourceModel()],
      [specFile, sourceModel({ errors: [{ line: 3, message: "boom" }] })],
    ]);
    expect(pickDefaultFile(undefined, sources)).toBe(specFile);
  });

  it("falls back to the first real file when nothing has an error", () => {
    const sources = new Map([
      [syntheticFile, sourceModel()],
      [helpersFile, sourceModel()],
      [specFile, sourceModel()],
    ]);
    expect(pickDefaultFile(undefined, sources)).toBe(helpersFile);
  });

  it("returns undefined when sources hold only synthetic files", () => {
    const sources = new Map([[syntheticFile, sourceModel()]]);
    expect(pickDefaultFile(undefined, sources)).toBeUndefined();
  });
});

describe('tokenizeSource: line-count invariant (mirrors content.split("\\n") exactly)', () => {
  it.each([
    ["empty string", ""],
    ["single line, no trailing newline", "const a = 1;"],
    ["trailing newline", "const a = 1;\n"],
    ["multi-line token span (template literal)", "const a = `foo\nbar`;\n"],
    [
      "CRLF line endings (the \\r rides along as trailing text on each line, not its own break)",
      "const a = 1;\r\nconst b = 2;\r\n",
    ],
  ])("%s", (_label, content) => {
    const lines = tokenizeSource(content, "/repo/file.ts");
    expect(lines).toBeDefined();
    expect(lines!.length).toBe(content.split("\n").length);
  });
});

describe("tokenizeSource: dialect fallback", () => {
  it("returns undefined for a non-JS/TS extension (plain-text fallback)", () => {
    expect(
      tokenizeSource("def add(a, b):\n    return a + b", "/repo/gen.py"),
    ).toBeUndefined();
  });

  it("returns undefined for a file with no extension", () => {
    expect(tokenizeSource("some text", "/repo/README")).toBeUndefined();
  });

  it("tokenizes .ts content into tok-* classed segments", () => {
    const lines = tokenizeSource('const total = "x";', "/repo/file.ts");
    expect(lines).toBeDefined();
    const flat = lines!.flat();
    expect(
      flat.some(
        (seg) => seg.className === "tok-keyword" && seg.text === "const",
      ),
    ).toBe(true);
    expect(
      flat.some((seg) => seg.className === "tok-string" && seg.text === '"x"'),
    ).toBe(true);
  });

  it("tokenizes .tsx content using the ts+jsx dialect", () => {
    const lines = tokenizeSource("const el = <div />;", "/repo/file.tsx");
    expect(lines).toBeDefined();
  });
});

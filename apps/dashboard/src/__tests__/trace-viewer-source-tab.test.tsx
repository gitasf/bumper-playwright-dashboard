import { createHash } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  boundSourcePreview,
  SOURCE_PREVIEW_LIMITS,
  SourceTab,
} from "@/trace-viewer/components/source-tab";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeBridge,
  makeModel,
  makeTabProps,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Component tests for the Source tab: line-numbered rendering, the pure-lezer
 * syntax highlighting (`tok-*` spans from `@lezer/javascript` +
 * `@lezer/highlight`'s classHighlighter — deliberately NOT CodeMirror, see
 * the comment above `SourceLines`), the plain-text fallback for non-JS/TS
 * files, target-line highlighting from the selected stack frame, the frame
 * picker, and the sha1-addressed lazy content fetch through the bridge.
 */

const SPEC_FILE = "/repo/tests/checkout.spec.ts";
const HELPERS_FILE = "/repo/tests/helpers.ts";

const SPEC_CONTENT = [
  "const total = 42;",
  'const label = "checkout";',
  "// tallies the cart",
  "line four",
  "line five",
  "line six",
  "line seven",
  "line eight",
  'await page.click("#checkout");',
  "line ten",
].join("\n");

const HELPERS_CONTENT = "export function helper(): void {}";

let restoreDomStubs: () => void;

beforeEach(() => {
  // SourceLines scrollIntoView()s the target line on mount; happy-dom may or
  // may not ship the method, so stub either way (same pattern as the sibling
  // trace-viewer component suites).
  restoreDomStubs = installTraceViewerDomStubs({ scrollIntoView: true });
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

/** Fixture model with both spec + helper source contents pre-seeded (skips
 * the sha1 fetch path) and `call@2` (whose stack spans both files) selected. */
function seededProps(): ReturnType<typeof makeTabProps> {
  const model = makeModel();
  model.sources.get(SPEC_FILE)!.content = SPEC_CONTENT;
  model.sources.get(HELPERS_FILE)!.content = HELPERS_CONTENT;
  const selectedAction = model.actions.find((a) => a.callId === "call@2");
  return makeTabProps({ model, selectedAction });
}

function propsWithSpecContent(
  content: string,
): ReturnType<typeof makeTabProps> {
  const props = seededProps();
  props.model.sources.get(SPEC_FILE)!.content = content;
  return props;
}

describe("SourceTab", () => {
  it("renders pre-seeded file content with line numbers", () => {
    const { container } = render(<SourceTab {...seededProps()} />);
    const pre = container.querySelector("pre")!;
    expect(pre).toBeTruthy();
    expect(pre.textContent).toContain("const total = 42;");
    expect(pre.textContent).toContain("line ten");
    const lineNumbers = Array.from(
      pre.querySelectorAll("[data-line-number]"),
      (el) => el.textContent,
    );
    expect(lineNumbers).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  it("highlights .ts content: const → tok-keyword, string literal → tok-string", () => {
    const { container } = render(<SourceTab {...seededProps()} />);
    const keyword = Array.from(
      container.querySelectorAll('span[class*="tok-keyword"]'),
    ).find((el) => el.textContent === "const");
    expect(keyword).toBeTruthy();
    const string = Array.from(
      container.querySelectorAll('span[class*="tok-string"]'),
    ).find((el) => el.textContent === '"checkout"');
    expect(string).toBeTruthy();
  });

  it("renders non-JS files (.py) as plain text with no tok-* spans", () => {
    const pyFile = "/repo/scripts/gen.py";
    const pyAction = makeAction({
      callId: "call@py",
      startTime: 1000,
      endTime: 1500,
      stack: [{ file: pyFile, line: 1, column: 1 }],
    });
    const model = makeModel({ actions: [pyAction] });
    model.sources.get(pyFile)!.content = "def add(a, b):\n    return a + b";
    const selectedAction = model.actions.find((a) => a.callId === "call@py");
    const { container } = render(
      <SourceTab {...makeTabProps({ model, selectedAction })} />,
    );
    expect(screen.getByText("def add(a, b):")).toBeTruthy();
    expect(container.querySelector('[class*="tok-"]')).toBeNull();
  });

  it("highlights the selected frame's target line", () => {
    // call@2's first stack frame is checkout.spec.ts:9.
    const { container } = render(<SourceTab {...seededProps()} />);
    const highlighted = container.querySelector(
      'pre [data-current-line="true"]',
    )!;
    expect(highlighted).toBeTruthy();
    expect(highlighted.textContent).toContain("#checkout");
    expect(highlighted.textContent).toContain("9");
  });

  it("lists stack frames and switches file when a frame is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(<SourceTab {...seededProps()} />);
    // Both of call@2's frames render in the picker.
    expect(screen.getByText("checkout.spec.ts:9")).toBeTruthy();
    expect(screen.getByText("helpers.ts:22")).toBeTruthy();
    expect(container.querySelector("pre")!.textContent).toContain(
      "const total",
    );

    await user.click(screen.getByText("helpers.ts:22"));
    expect(container.querySelector("pre")!.textContent).toContain(
      "function helper(): void",
    );
  });

  it("hides Playwright's synthetic project#<id> frame from tabs, default file, and frame picker", () => {
    // Mirrors the fixture-pool location Playwright synthesizes for
    // project-level `use` option overrides — never a real source file.
    const SYNTHETIC_FILE = "project#abc123";
    const action = makeAction({
      callId: "call@synthetic",
      startTime: 1000,
      endTime: 1500,
      stack: [
        { file: SYNTHETIC_FILE, line: 1, column: 1 },
        { file: SPEC_FILE, line: 9, column: 3 },
      ],
    });
    const model = makeModel({ actions: [action] });
    model.sources.get(SPEC_FILE)!.content = SPEC_CONTENT;
    const selectedAction = model.actions.find(
      (a) => a.callId === "call@synthetic",
    );
    render(<SourceTab {...makeTabProps({ model, selectedAction })} />);

    // No tab for the synthetic file, and the real file was picked as default
    // (skipping the synthetic frame at index 0) despite not being selected.
    expect(screen.queryByText(SYNTHETIC_FILE)).toBeNull();
    expect(screen.getByText("checkout.spec.ts")).toBeTruthy();

    // The frame picker still lists the synthetic frame, but disabled.
    const syntheticRow = screen.getByTitle(SYNTHETIC_FILE);
    expect(syntheticRow.tagName).toBe("BUTTON");
    expect((syntheticRow as HTMLButtonElement).disabled).toBe(true);
  });

  it("lazily fetches unseeded content via sha1(src@…) through the bridge", async () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@1");
    const sha1 = createHash("sha1").update(SPEC_FILE).digest("hex");
    const bridge = makeBridge({ [`sha1/src@${sha1}.txt`]: SPEC_CONTENT });
    render(<SourceTab {...makeTabProps({ model, selectedAction, bridge })} />);
    // "42" is unique in the fixture content (unlike "const"), and arrives as
    // its own tok-number span once the fetched content is tokenized.
    expect(await screen.findByText("42")).toBeTruthy();
    expect(bridge.calls).toContain(
      `sha1/src@${sha1}.txt?trace=${encodeURIComponent(FIXTURE_TRACE_URL)}`,
    );
    // The fetch result is cached back onto the shared model.
    expect(model.sources.get(SPEC_FILE)!.content).toBe(SPEC_CONTENT);
  });

  it("rejects an oversized source blob before decoding it as text", async () => {
    const text = vi.fn(() => Promise.resolve("must not be decoded"));
    const blob = {
      size: 1_000_001,
      text,
    } as unknown as Blob;
    const bridge = makeBridge();
    bridge.fetchBlob = vi.fn(() => Promise.resolve(blob));
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@1");

    render(<SourceTab {...makeTabProps({ bridge, model, selectedAction })} />);

    expect(
      await screen.findByText("Source file is too large to preview."),
    ).toBeTruthy();
    expect(bridge.fetchBlob).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("caps rendered source characters below the fetch limit", () => {
    const content = "x".repeat(SOURCE_PREVIEW_LIMITS.renderChars + 1);
    const { container } = render(
      <SourceTab {...propsWithSpecContent(content)} />,
    );

    const code = container.querySelector(
      '[data-line-number="1"] + span',
    ) as HTMLElement;
    expect(code.textContent).toHaveLength(SOURCE_PREVIEW_LIMITS.renderChars);
    expect(screen.getByText("… source preview truncated")).toBeTruthy();
  });

  it("highlights only content within the syntax-highlighting cap", () => {
    const snippet = 'const value = "checkout";';
    const withinCap = snippet.padEnd(SOURCE_PREVIEW_LIMITS.highlightChars, " ");
    const within = render(<SourceTab {...propsWithSpecContent(withinCap)} />);

    expect(within.container.querySelector(".tok-keyword")?.textContent).toBe(
      "const",
    );
    within.unmount();

    const beyondCap = snippet.padEnd(
      SOURCE_PREVIEW_LIMITS.highlightChars + 1,
      " ",
    );
    const beyond = render(<SourceTab {...propsWithSpecContent(beyondCap)} />);
    expect(beyond.container.querySelector('[class*="tok-"]')).toBeNull();
    expect(
      beyond.container.querySelector('[data-line-number="1"] + span')
        ?.textContent,
    ).toHaveLength(SOURCE_PREVIEW_LIMITS.highlightChars + 1);
  });
});

/**
 * The line cap is asserted against the pure bounding helper rather than a
 * render: mounting `renderLines + 1` lines costs ~20k happy-dom nodes, which
 * ran past the 5s test timeout under coverage in CI. The character-cap test
 * above covers the same helper's wiring into the rendered `<pre>` — bounded
 * text plus the truncation notice — at one line's worth of DOM.
 */
describe("boundSourcePreview", () => {
  it("caps lines at renderLines and reports the truncation", () => {
    const content = Array.from(
      { length: SOURCE_PREVIEW_LIMITS.renderLines + 1 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");

    const { lines, truncated } = boundSourcePreview(content);

    expect(lines).toHaveLength(SOURCE_PREVIEW_LIMITS.renderLines);
    expect(lines.at(-1)).toBe(`line-${SOURCE_PREVIEW_LIMITS.renderLines}`);
    expect(truncated).toBe(true);
  });

  it("leaves content within both caps untouched", () => {
    const { lines, truncated } = boundSourcePreview(SPEC_CONTENT);

    expect(lines).toEqual(SPEC_CONTENT.split("\n"));
    expect(truncated).toBe(false);
  });
});

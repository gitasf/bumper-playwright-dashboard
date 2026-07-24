import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourceTab } from "@/trace-viewer/components/source-tab";
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
});

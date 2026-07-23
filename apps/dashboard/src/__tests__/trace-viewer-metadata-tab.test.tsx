import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import { MetadataTab } from "@/trace-viewer/components/metadata-tab";
import { makeTabProps } from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

// happy-dom gap: the vendored Base UI ScrollArea (used by sibling detail
// panels within DetailTabs) polls viewport.getAnimations() on a timer; stub
// it so that doesn't throw (matches the sibling call-tab/errors-tab suites
// split from the same source file).
let restoreDomStubs: () => void;
beforeAll(() => {
  restoreDomStubs = installTraceViewerDomStubs({ getAnimations: true });
});
afterAll(() => {
  restoreDomStubs();
});

afterEach(() => {
  cleanup();
});

describe("MetadataTab", () => {
  it("renders browser, viewport, playwright version and page count", () => {
    render(<MetadataTab {...makeTabProps()} />);
    expect(screen.getByText("chromium")).toBeTruthy();
    expect(screen.getByText("1280×720")).toBeTruthy();
    expect(screen.getByText("1.61.1")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // Pages count
  });
});

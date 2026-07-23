import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorsTab } from "@/trace-viewer/components/errors-tab";
import { makeTabProps } from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

// happy-dom gap: the vendored Base UI ScrollArea (used by ErrorsTab) polls
// viewport.getAnimations() on a timer; stub it so that doesn't throw.
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

describe("ErrorsTab", () => {
  it("renders the error message", () => {
    render(<ErrorsTab {...makeTabProps()} />);
    expect(screen.getByText(/expect failed: total mismatch/)).toBeTruthy();
  });

  it("jumping to the failing action calls onSelectAction with its call id", async () => {
    const user = userEvent.setup();
    const onSelectAction = vi.fn();
    render(<ErrorsTab {...makeTabProps({ onSelectAction })} />);
    await user.click(screen.getByRole("button", { name: /toHaveText/i }));
    expect(onSelectAction).toHaveBeenCalledWith("call@4");
  });

  it("copies an LLM prompt to the clipboard and flips the label to Copied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<ErrorsTab {...makeTabProps()} />);

    const copyButton = screen.getByRole("button", { name: /copy prompt/i });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0]?.[0] as string;
    expect(written).toContain("expect failed: total mismatch");
    expect(written).toContain("Failing action:");

    expect(await screen.findByRole("button", { name: /copied/i })).toBeTruthy();
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailTabs } from "@/trace-viewer/components/detail-tabs";
import {
  makeAction,
  makeBridge,
  makeModel,
  makeTabProps,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

// happy-dom gaps hit by the vendored Base UI ScrollArea / action-row ref:
// getAnimations() isn't implemented (ScrollAreaViewport polls it on a
// timer), and scrollIntoView isn't implemented either. Both are no-ops here.
let restoreDomStubs: () => void;
beforeAll(() => {
  restoreDomStubs = installTraceViewerDomStubs({
    getAnimations: true,
    scrollIntoView: true,
  });
});
afterAll(() => {
  restoreDomStubs();
});

function tab(name: string): HTMLElement {
  const found = screen
    .getAllByRole("tab")
    .find((t) => t.textContent?.startsWith(name));
  if (!found) throw new Error(`no tab labelled "${name}"`);
  return found;
}

/**
 * Renders `<DetailTabs>` from `makeTabProps` overrides — `bridge` and (when
 * unset) `selection: null` come along for free, so a test only states the
 * fields it actually pins down.
 */
function renderDetailTabs(
  overrides: Parameters<typeof makeTabProps>[0] = {},
): ReturnType<typeof render> {
  return render(<DetailTabs {...makeTabProps(overrides)} />);
}

afterEach(() => {
  cleanup();
});

describe("DetailTabs — default tab", () => {
  it("defaults to Errors when the model has errors", () => {
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(tab("Errors").getAttribute("aria-selected")).toBe("true");
  });

  it("defaults to Call when the model has no errors", () => {
    // Same shape as the fixture but without call@4, the only action that
    // carries an error.
    const model = makeModel({
      actions: [
        makeAction({
          callId: "call@1",
          method: "goto",
          title: "Navigate to app",
          params: { url: "https://app.example/" },
          startTime: 1000,
          endTime: 1400,
        }),
      ],
    });
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(tab("Call").getAttribute("aria-selected")).toBe("true");
    expect(tab("Errors").getAttribute("aria-selected")).toBe("false");
  });
});

describe("DetailTabs — tab label counts", () => {
  it("shows whole-trace counts on Errors, Console, Network and Attachments", () => {
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(tab("Errors").textContent).toBe("Errors1");
    expect(tab("Console").textContent).toBe("Console3");
    expect(tab("Network").textContent).toBe("Network2");
    // The `_hidden` attachment on call@2 is excluded from visibleAttachments —
    // 3 raw attachments, 2 visible.
    expect(tab("Attachments").textContent).toBe("Attachments2");
  });

  it("narrows Console/Network counts to the timeline selection window", () => {
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
      selection: { start: 2000, end: 3000 },
    });
    // In-window: the "boom red" console error (2200) and the items request
    // (_monotonicTime 2100). Errors/Attachments counts stay whole-trace.
    expect(tab("Console").textContent).toBe("Console1");
    expect(tab("Network").textContent).toBe("Network1");
    expect(tab("Errors").textContent).toBe("Errors1");
    expect(tab("Attachments").textContent).toBe("Attachments2");
  });

  it("renders the Errors count as a Badge, not the plain muted span other tabs use", () => {
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(
      tab("Errors").querySelector('[data-slot="badge"]')?.textContent,
    ).toBe("1");
    expect(tab("Console").querySelector('[data-slot="badge"]')).toBeNull();
    expect(tab("Network").querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe("DetailTabs — Source tab presence", () => {
  it("is present when the model has source", () => {
    const model = makeModel({ hasSource: true });
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(
      screen.getAllByRole("tab").some((t) => t.textContent === "Source"),
    ).toBe(true);
  });

  it("is absent when the model has no source", () => {
    const model = makeModel({ hasSource: false });
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(
      screen.getAllByRole("tab").some((t) => t.textContent === "Source"),
    ).toBe(false);
  });
});

describe("DetailTabs — Source tab follows activeAction, not selectedAction", () => {
  it("renders the hovered action's source, not the selected action's, while it differs", async () => {
    const user = userEvent.setup();
    const SPEC_FILE = "/repo/tests/checkout.spec.ts";
    const HELPERS_FILE = "/repo/tests/helpers.ts";
    const model = makeModel({
      actions: [
        makeAction({
          callId: "call@1",
          method: "goto",
          title: "Navigate to app",
          startTime: 1000,
          endTime: 1400,
          stack: [{ file: SPEC_FILE, line: 5, column: 3 }],
        }),
        makeAction({
          callId: "call@2",
          method: "click",
          title: "Click checkout",
          params: { selector: "#checkout" },
          startTime: 2000,
          endTime: 2600,
          stack: [{ file: HELPERS_FILE, line: 22, column: 5 }],
        }),
      ],
    });
    model.sources.get(SPEC_FILE)!.content = "const total = 42;";
    model.sources.get(HELPERS_FILE)!.content =
      "export function helper(): void {}";
    const selectedAction = model.actions.find((a) => a.callId === "call@1");
    const activeAction = model.actions.find((a) => a.callId === "call@2");

    const { container } = renderDetailTabs({
      model,
      selectedAction,
      activeAction,
    });

    await user.click(tab("Source"));

    // Hovered action (call@2, helpers.ts) drives the Source pane…
    expect(container.textContent).toContain("export function helper");
    expect(container.textContent).not.toContain("const total = 42;");
  });
});

describe("DetailTabs — Call/Log tabs follow activeAction, not selectedAction", () => {
  function renderWithDistinctActions(): void {
    const model = makeModel({
      actions: [
        makeAction({
          callId: "call@1",
          method: "goto",
          title: "Navigate to app",
          params: { url: "https://app.example/" },
          startTime: 1000,
          endTime: 1400,
          log: [{ time: 1000, message: "navigating to app" }],
        }),
        makeAction({
          callId: "call@2",
          method: "click",
          title: "Click checkout",
          params: { selector: "#checkout" },
          startTime: 2000,
          endTime: 2600,
          log: [{ time: 2000, message: "clicking #checkout" }],
        }),
      ],
    });
    const selectedAction = model.actions.find((a) => a.callId === "call@1");
    const activeAction = model.actions.find((a) => a.callId === "call@2");

    renderDetailTabs({ model, selectedAction, activeAction });
  }

  it("Call tab renders the active (hovered) action's params, not the selected action's", () => {
    renderWithDistinctActions();

    // Active action (call@2, #checkout) drives the Call pane…
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText('"#checkout"')).toBeTruthy();
    // …not the selected action (call@1).
    expect(screen.queryByText("Navigate to app")).toBeNull();
  });

  it("Log tab renders the active (hovered) action's log entries, not the selected action's", async () => {
    const user = userEvent.setup();
    renderWithDistinctActions();

    await user.click(tab("Log"));

    // Active action (call@2)'s log entry…
    expect(screen.getByText("clicking #checkout")).toBeTruthy();
    // …not the selected action's (call@1).
    expect(screen.queryByText("navigating to app")).toBeNull();
  });
});

describe("DetailTabs — Log tab timeline selection", () => {
  function renderLogWithSelection(selection: {
    start: number;
    end: number;
  }): void {
    const model = makeModel({
      actions: [
        makeAction({
          callId: "call@1",
          method: "click",
          title: "Click checkout",
          params: { selector: "#checkout" },
          startTime: 2000,
          endTime: 4000,
          log: [
            { time: 2100, message: "waiting for #checkout" },
            { time: 3500, message: "performing click" },
          ],
        }),
      ],
    });
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
      selection,
    });
  }

  it("shows only log entries inside the selection window", async () => {
    const user = userEvent.setup();
    renderLogWithSelection({ start: 2000, end: 3000 });
    await user.click(tab("Log"));
    expect(screen.getByText("waiting for #checkout")).toBeTruthy();
    expect(screen.queryByText("performing click")).toBeNull();
  });

  it("shows a selection-empty message when no entries fall in the window", async () => {
    const user = userEvent.setup();
    renderLogWithSelection({ start: 4500, end: 4900 });
    await user.click(tab("Log"));
    expect(
      screen.getByText("No log entries in the selected timeline range."),
    ).toBeTruthy();
  });
});

describe("DetailTabs — crosshair scope toggle", () => {
  const scopeToggle = () =>
    screen.queryByRole("button", { pressed: false }) ??
    screen.queryByRole("button", { pressed: true });

  it("is absent on Call and Errors", () => {
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });
    expect(scopeToggle()).toBeNull();
  });

  it("is present on Console and Network, and clicking sets aria-pressed", async () => {
    const user = userEvent.setup();
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });

    await user.click(tab("Console"));
    const consoleToggle = scopeToggle();
    expect(consoleToggle?.getAttribute("aria-pressed")).toBe("false");
    await user.click(consoleToggle!);
    expect(consoleToggle?.getAttribute("aria-pressed")).toBe("true");

    await user.click(tab("Network"));
    expect(scopeToggle()).not.toBeNull();
  });
});

describe("DetailTabs — panel switching", () => {
  it("keeps the chosen tab but resets panel-local state when the trace model changes", async () => {
    const user = userEvent.setup();
    const firstModel = makeModel();
    const firstProps = makeTabProps({
      model: firstModel,
      selectedAction: firstModel.actions[0],
      activeAction: firstModel.actions[0],
    });
    const { rerender } = render(<DetailTabs {...firstProps} />);

    await user.click(tab("Network"));
    const filter = screen.getByRole("searchbox", { name: "Filter requests" });
    await user.type(filter, "checkout");
    expect(screen.queryByText("items")).toBeNull();

    const nextModel = makeModel();
    rerender(
      <DetailTabs
        {...makeTabProps({
          model: nextModel,
          selectedAction: nextModel.actions[0],
          activeAction: nextModel.actions[0],
          bridge: makeBridge(
            {},
            "https://dash.test/api/artifacts/a2/download?t=next",
          ),
        })}
      />,
    );

    // The outer DetailTabs state survives, so Network remains selected; the
    // keyed panel subtree is fresh, so attempt A's filter cannot hide attempt
    // B's requests.
    expect(tab("Network").getAttribute("aria-selected")).toBe("true");
    expect(
      (
        screen.getByRole("searchbox", {
          name: "Filter requests",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(screen.getByText("items")).toBeTruthy();
  });

  it("renders a distinctive panel for each tab", async () => {
    const user = userEvent.setup();
    const model = makeModel();
    renderDetailTabs({
      model,
      selectedAction: model.actions[0],
      activeAction: model.actions[0],
    });

    await user.click(tab("Call"));
    expect(screen.getByText("Navigate to app")).toBeTruthy();

    await user.click(tab("Log"));
    expect(screen.getByText("No log entries for this action.")).toBeTruthy();

    await user.click(tab("Errors"));
    expect(screen.getByText(/expect failed: total mismatch/)).toBeTruthy();

    await user.click(tab("Console"));
    expect(screen.getByText("loading cart")).toBeTruthy();

    await user.click(tab("Network"));
    expect(screen.getAllByText(/checkout/).length).toBeGreaterThan(0);

    await user.click(tab("Source"));
    expect(screen.getByText("checkout.spec.ts")).toBeTruthy();

    await user.click(tab("Attachments"));
    expect(screen.getByText("shot.png")).toBeTruthy();

    await user.click(tab("Metadata"));
    expect(screen.getByText("chromium")).toBeTruthy();
    expect(screen.getByText("1.61.1")).toBeTruthy();
  });
});

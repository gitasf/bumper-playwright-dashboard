import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionList } from "@/trace-viewer/components/action-list";
import { makeAction, makeModel } from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

// happy-dom doesn't implement scrollIntoView; the selected row calls it from
// a selection-keyed useEffect, so a no-op polyfill keeps render from throwing.
let restoreDomStubs: () => void;
beforeAll(() => {
  restoreDomStubs = installTraceViewerDomStubs({ scrollIntoView: true });
});
afterAll(() => {
  restoreDomStubs();
});

const SHOWN_GROUPS_KEY = "wrightful:trace-viewer:shown-action-groups";

/** A nested tree — `call@1` (a step) parenting `call@2` (click, `#checkout`)
 * and `call@4` (a failing expect) — for the ancestor-visibility and
 * collapse-chevron cases the flat fixture can't exercise. Its subtree
 * contains an error (`call@4`), so `call@1` is expanded by default under
 * the new "collapsed unless it hides an error" semantics. */
function nestedModel() {
  return makeModel({
    actions: [
      makeAction({
        callId: "call@1",
        method: "step",
        title: "Checkout flow",
        startTime: 1000,
        endTime: 5000,
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        parentId: "call@1",
        startTime: 2000,
        endTime: 2600,
      }),
      makeAction({
        callId: "call@4",
        method: "expect",
        title: 'Expect "toHaveText"',
        params: { selector: "#total" },
        parentId: "call@1",
        startTime: 3000,
        endTime: 4000,
        error: { name: "Error", message: "expect failed: total mismatch" },
      }),
    ],
  });
}

/**
 * A nested tree with NO error anywhere — `call@1` (a step) parenting
 * `call@2` (click). Used to assert the plain "collapsed by default" case
 * without an error branch forcing anything open.
 */
function nestedModelNoError() {
  return makeModel({
    actions: [
      makeAction({
        callId: "call@1",
        method: "step",
        title: "Checkout flow",
        startTime: 1000,
        endTime: 5000,
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        parentId: "call@1",
        startTime: 2000,
        endTime: 2600,
      }),
    ],
  });
}

/**
 * Two sibling step groups under the root: `call@1` ("Checkout flow", no
 * error) containing `call@2`, and `call@5` ("Payment flow") containing a
 * nested `call@6` ("Charge card" — no error) which itself contains the
 * failing `call@4`. Exercises "the whole ancestor chain down to the error
 * must be expanded" across more than one level, while an unrelated
 * error-free sibling group stays collapsed.
 */
function deeplyNestedModelWithError() {
  return makeModel({
    actions: [
      makeAction({
        callId: "call@1",
        method: "step",
        title: "Checkout flow",
        startTime: 1000,
        endTime: 1900,
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        parentId: "call@1",
        startTime: 1000,
        endTime: 1500,
      }),
      makeAction({
        callId: "call@5",
        method: "step",
        title: "Payment flow",
        startTime: 2000,
        endTime: 5000,
      }),
      makeAction({
        callId: "call@6",
        method: "step",
        title: "Charge card",
        parentId: "call@5",
        startTime: 2000,
        endTime: 5000,
      }),
      makeAction({
        callId: "call@4",
        method: "expect",
        title: 'Expect "toHaveText"',
        params: { selector: "#total" },
        parentId: "call@6",
        startTime: 3000,
        endTime: 4000,
        error: { name: "Error", message: "expect failed: total mismatch" },
      }),
    ],
  });
}

/**
 * `nestedModelNoError` plus a route-grouped action, so a test can toggle the
 * `route` chip (which rebuilds the tree) and assert manual expand/collapse
 * choices survive the rebuild.
 */
function nestedModelNoErrorWithRoute() {
  return makeModel({
    actions: [
      makeAction({
        callId: "call@1",
        method: "step",
        title: "Checkout flow",
        startTime: 1000,
        endTime: 5000,
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        parentId: "call@1",
        startTime: 2000,
        endTime: 2600,
      }),
      makeAction({
        callId: "call@3",
        class: "Route",
        method: "continue",
        title: "Route.continue",
        group: "route",
        startTime: 2050,
        endTime: 2060,
      }),
    ],
  });
}

function optionRow(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[role="option"]');
  if (!row) throw new Error(`no option row for "${text}"`);
  return row as HTMLElement;
}

const noop = () => {
  /* default onSelect for renders that don't assert selection */
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ActionList — grouped actions hidden by default", () => {
  it("renders non-grouped rows and hides the route-grouped action", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.getByText("Navigate to app")).toBeTruthy();
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
    expect(screen.queryByText("Route.continue")).toBeNull();
  });

  it("shows a chip with the hidden group's count", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    const chip = screen.getByRole("button", { name: /route 1/i });
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking the chip reveals the row and persists the choice to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.queryByText("Route.continue")).toBeNull();

    await user.click(screen.getByRole("button", { name: /route 1/i }));

    expect(screen.getByText("Route.continue")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /route 1/i })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      JSON.parse(window.localStorage.getItem(SHOWN_GROUPS_KEY) ?? "[]"),
    ).toEqual(["route"]);
  });
});

describe("ActionList — selection", () => {
  it("clicking a row calls onSelect with its call id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={onSelect}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.click(screen.getByText("Click checkout"));
    expect(onSelect).toHaveBeenCalledWith("call@2");
  });

  it("marks the selected row aria-selected and leaves others unselected", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId="call@2"
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(optionRow("Click checkout").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(optionRow("Navigate to app").getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("ArrowDown on the listbox moves selection to the next visible row", () => {
    const onSelect = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId="call@1"
        onSelect={onSelect}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("call@2");
  });
});

describe("ActionList — search", () => {
  const search = () =>
    screen.getByRole("searchbox", { name: "Filter actions" });

  it("narrows to title matches", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.type(search(), "checkout");
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.queryByText("Navigate to app")).toBeNull();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
  });

  it("matches by selector param text (#checkout)", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.type(search(), "#checkout");
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.queryByText("Navigate to app")).toBeNull();
  });

  it("keeps ancestors of a match visible", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={nestedModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.type(search(), "#checkout");
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText("Checkout flow")).toBeTruthy(); // ancestor, no own match
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
  });

  it("clearing the query restores the full list", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.type(search(), "checkout");
    await user.clear(search());
    expect(screen.getByText("Navigate to app")).toBeTruthy();
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
  });

  it("shows the empty note when nothing matches", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.type(search(), "no-such-action-zzz");
    expect(screen.getByText("No actions recorded in this trace.")).toBeTruthy();
  });
});

describe("ActionList — collapse", () => {
  it("the chevron hides descendants, and toggling again reveals them", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={nestedModel()} // error subtree → expanded by default
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.getByText("Click checkout")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText("Click checkout")).toBeNull();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Click checkout")).toBeTruthy();
  });
});

describe("ActionList — default collapse state", () => {
  it("an error-free group starts collapsed (children hidden, chevron says Expand)", () => {
    render(
      <ActionList
        model={nestedModelNoError()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.getByText("Checkout flow")).toBeTruthy();
    expect(screen.queryByText("Click checkout")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
  });

  it("a group whose subtree contains a failing action starts expanded down to the error", () => {
    render(
      <ActionList
        model={deeplyNestedModelWithError()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    // The whole ancestor chain above the error is open…
    expect(screen.getByText("Payment flow")).toBeTruthy();
    expect(screen.getByText("Charge card")).toBeTruthy();
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
    // …while the error-free sibling group stays collapsed.
    expect(screen.getByText("Checkout flow")).toBeTruthy();
    expect(screen.queryByText("Click checkout")).toBeNull();
  });
});

describe("ActionList — auto-reveal on external selection", () => {
  it("rerendering with a selectedCallId inside a collapsed group expands its ancestors", () => {
    const model = nestedModelNoError();
    const { rerender } = render(
      <ActionList
        model={model}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.queryByText("Click checkout")).toBeNull();

    rerender(
      <ActionList
        model={model}
        selectedCallId="call@2"
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );

    const row = optionRow("Click checkout");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("reveals through multiple collapsed levels and leaves unrelated groups collapsed", async () => {
    const user = userEvent.setup();
    const model = deeplyNestedModelWithError();
    const { rerender } = render(
      <ActionList
        model={model}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    // Manually collapse the (default-expanded) error chain, innermost first,
    // so call@4 ends up hidden under TWO collapsed ancestors.
    await user.click(
      within(optionRow("Charge card")).getByRole("button", {
        name: "Collapse",
      }),
    );
    await user.click(
      within(optionRow("Payment flow")).getByRole("button", {
        name: "Collapse",
      }),
    );
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();

    rerender(
      <ActionList
        model={model}
        selectedCallId="call@4"
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );

    expect(screen.getByText("Charge card")).toBeTruthy();
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
    // Unrelated error-free group is untouched (still collapsed).
    expect(screen.queryByText("Click checkout")).toBeNull();
  });
});

describe("ActionList — manual toggles survive group-chip changes", () => {
  it("a manually expanded group stays expanded after toggling the route chip", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={nestedModelNoErrorWithRoute()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.queryByText("Click checkout")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Click checkout")).toBeTruthy();

    // Toggling the chip rebuilds the tree; the manual expand must survive.
    await user.click(screen.getByRole("button", { name: /route 1/i }));
    expect(screen.getByText("Route.continue")).toBeTruthy();
    expect(screen.getByText("Click checkout")).toBeTruthy();

    // And back off again.
    await user.click(screen.getByRole("button", { name: /route 1/i }));
    expect(screen.queryByText("Route.continue")).toBeNull();
    expect(screen.getByText("Click checkout")).toBeTruthy();
  });

  it("a manual collapse of a default-expanded error group survives a chip toggle", async () => {
    const user = userEvent.setup();
    render(
      <ActionList
        model={makeModel({
          actions: [
            makeAction({
              callId: "call@1",
              method: "step",
              title: "Checkout flow",
              startTime: 1000,
              endTime: 5000,
            }),
            makeAction({
              callId: "call@4",
              method: "expect",
              title: 'Expect "toHaveText"',
              parentId: "call@1",
              startTime: 3000,
              endTime: 4000,
              error: { name: "Error", message: "expect failed" },
            }),
            makeAction({
              callId: "call@3",
              class: "Route",
              method: "continue",
              title: "Route.continue",
              group: "route",
              startTime: 2050,
              endTime: 2060,
            }),
          ],
        })}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    // Error subtree → expanded by default; collapse it manually.
    expect(screen.getByText('Expect "toHaveText"')).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();

    await user.click(screen.getByRole("button", { name: /route 1/i }));
    expect(screen.getByText("Route.continue")).toBeTruthy();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
  });
});

describe("ActionList — row click toggles collapse", () => {
  it("clicking a row with children selects it and toggles its collapse state", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActionList
        model={nestedModelNoError()} // starts collapsed by default
        selectedCallId={undefined}
        onSelect={onSelect}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.queryByText("Click checkout")).toBeNull();

    await user.click(screen.getByText("Checkout flow"));
    expect(onSelect).toHaveBeenCalledWith("call@1");
    expect(screen.getByText("Click checkout")).toBeTruthy();

    await user.click(screen.getByText("Checkout flow"));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Click checkout")).toBeNull();
  });

  it("clicking the chevron still toggles without selecting", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActionList
        model={nestedModelNoError()}
        selectedCallId={undefined}
        onSelect={onSelect}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Click checkout")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking a leaf row (no children) only selects, without touching a sibling's collapse", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={onSelect}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    await user.click(screen.getByText("Click checkout"));
    expect(onSelect).toHaveBeenCalledWith("call@2");
  });
});

describe("ActionList — hover preview", () => {
  it("reports the hovered row's callId immediately, and clears it when the pointer leaves the list", () => {
    const onHover = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={onHover}
        selection={null}
        onClearSelection={noop}
      />,
    );

    fireEvent.pointerEnter(optionRow("Click checkout"));
    expect(onHover).toHaveBeenCalledWith("call@2");

    fireEvent.pointerLeave(screen.getByRole("listbox"));
    expect(onHover).toHaveBeenLastCalledWith(undefined);
  });

  it("reports each row entered in order, with no debounce", () => {
    const onHover = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={onHover}
        selection={null}
        onClearSelection={noop}
      />,
    );

    fireEvent.pointerEnter(optionRow("Navigate to app"));
    fireEvent.pointerEnter(optionRow("Click checkout"));

    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenNthCalledWith(1, "call@1");
    expect(onHover).toHaveBeenNthCalledWith(2, "call@2");
  });
});

describe("ActionList — timeline selection scope", () => {
  it("shows only actions intersecting the selection, with a Show all bar", () => {
    // Fixture actions: call@1 (1000–1400), call@2 (2000–2600), call@4
    // (3000–4000); a 1750–2800 window keeps only call@2.
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        selection={{ start: 1750, end: 2800 }}
        onClearSelection={noop}
        onHover={noop}
      />,
    );
    expect(optionRow("Click checkout")).toBeTruthy();
    expect(screen.queryByText("Navigate to app")).toBeNull();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
    expect(screen.getByText("Timeline selection")).toBeTruthy();
  });

  it("includes actions that only partially overlap the window", () => {
    // 1200–2100 overlaps call@1's tail (ends 1400) and call@2's head
    // (starts 2000) — both stay; call@4 (starts 3000) is out.
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        selection={{ start: 1200, end: 2100 }}
        onClearSelection={noop}
        onHover={noop}
      />,
    );
    expect(optionRow("Navigate to app")).toBeTruthy();
    expect(optionRow("Click checkout")).toBeTruthy();
    expect(screen.queryByText('Expect "toHaveText"')).toBeNull();
  });

  it("Show all clears the selection via onClearSelection", () => {
    const onClearSelection = vi.fn();
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        selection={{ start: 1750, end: 2800 }}
        onClearSelection={onClearSelection}
        onHover={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("shows a selection-specific empty state when nothing intersects", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        selection={{ start: 4500, end: 4900 }}
        onClearSelection={noop}
        onHover={noop}
      />,
    );
    expect(
      screen.getByText("No actions in the selected timeline range."),
    ).toBeTruthy();
  });

  it("renders no scope bar without a selection", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(screen.queryByText("Timeline selection")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });
});

describe("ActionList — failure indicator", () => {
  it("the failing action's row is flagged data-status=fail", () => {
    render(
      <ActionList
        model={makeModel()}
        selectedCallId={undefined}
        onSelect={noop}
        onHover={noop}
        selection={null}
        onClearSelection={noop}
      />,
    );
    expect(optionRow('Expect "toHaveText"').getAttribute("data-status")).toBe(
      "fail",
    );
    expect(optionRow("Navigate to app").getAttribute("data-status")).toBe("ok");
  });
});

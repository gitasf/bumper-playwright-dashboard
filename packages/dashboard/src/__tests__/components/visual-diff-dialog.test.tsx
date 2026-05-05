/**
 * Component coverage for the visual-diff dialog island. The reporter-side
 * unit tests assert the snapshot triple is grouped into the wire shape;
 * this asserts the dashboard renders that shape correctly — including the
 * tab fallbacks when frames are missing and the nuqs `?vmode=` round-trip.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type OnUrlUpdateFunction,
  withNuqsTestingAdapter,
} from "nuqs/adapters/testing";

import {
  VisualDiffRailButton,
  VisualDiffViewer,
} from "@/app/components/visual-diff-dialog";
import type {
  ArtifactAction,
  VisualDiffFrame,
  VisualDiffGroup,
} from "@/app/components/artifact-actions";

function frame(name: string): VisualDiffFrame {
  return { name, href: `https://artifacts.test/${name}` };
}

function fullGroup(): VisualDiffGroup {
  return {
    snapshotName: "landing.png",
    expected: frame("expected.png"),
    actual: frame("actual.png"),
    diff: frame("diff.png"),
  };
}

function renderViewer(
  group: VisualDiffGroup,
  searchParams = "",
  onUrlUpdate?: OnUrlUpdateFunction,
) {
  return render(<VisualDiffViewer group={group} />, {
    wrapper: withNuqsTestingAdapter({
      searchParams,
      hasMemory: true,
      onUrlUpdate,
    }),
  });
}

describe("VisualDiffViewer", () => {
  it("renders all four tabs with diff active by default", () => {
    renderViewer(fullGroup());

    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Diff",
    );
    expect(screen.getByRole("tab", { name: "Expected" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Actual" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Side-by-side" }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("img", { name: /diff for landing\.png/i }),
    ).toHaveAttribute("src", "https://artifacts.test/diff.png");
  });

  it("respects ?vmode= when the requested frame exists", () => {
    renderViewer(fullGroup(), "?vmode=actual");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Actual",
    );
    expect(
      screen.getByRole("img", { name: /actual capture for landing\.png/i }),
    ).toBeInTheDocument();
  });

  it("clicking a tab writes back ?vmode= via nuqs", async () => {
    const onUrlUpdate = vi.fn();
    const user = userEvent.setup();
    renderViewer(fullGroup(), "", onUrlUpdate);

    await user.click(screen.getByRole("tab", { name: "Expected" }));

    expect(onUrlUpdate).toHaveBeenCalled();
    const last = onUrlUpdate.mock.calls.at(-1)?.[0];
    expect(last?.searchParams.get("vmode")).toBe("expected");
  });

  it("renders the side-by-side panel with both labelled figures", async () => {
    const user = userEvent.setup();
    renderViewer(fullGroup());

    await user.click(screen.getByRole("tab", { name: "Side-by-side" }));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Expected")).toBeInTheDocument();
    expect(within(panel).getByText("Actual")).toBeInTheDocument();
    expect(
      within(panel).getByRole("img", {
        name: /expected baseline for landing\.png/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("img", {
        name: /actual capture for landing\.png/i,
      }),
    ).toBeInTheDocument();
  });

  it("omits Side-by-side when one of expected/actual is missing", () => {
    renderViewer({ ...fullGroup(), actual: null });

    expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Expected" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Actual" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Side-by-side" })).toBeNull();
  });

  it("falls back to the first available tab when ?vmode= names a missing frame", () => {
    renderViewer({ ...fullGroup(), diff: null }, "?vmode=diff");

    // Diff frame is gone, so the Diff tab is filtered out and the first
    // remaining tab (Expected) becomes active without persisting the change.
    expect(screen.queryByRole("tab", { name: "Diff" })).toBeNull();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Expected",
    );
  });

  it("falls back to the only remaining tab when two frames are missing", () => {
    renderViewer({
      snapshotName: "landing.png",
      expected: frame("expected.png"),
      actual: null,
      diff: null,
    });

    // Only Expected survives; the Side-by-side and Diff tabs/panels are dropped.
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Expected",
    );
    expect(
      screen.getByRole("img", { name: /expected baseline for landing\.png/i }),
    ).toBeInTheDocument();
  });
});

describe("VisualDiffRailButton", () => {
  function artifact(group: VisualDiffGroup | undefined): ArtifactAction {
    return {
      id: "art_1",
      type: "visual",
      name: "landing.png",
      contentType: "image/png",
      downloadHref: "https://artifacts.test/download",
      visualGroup: group,
    };
  }

  it("renders nothing when the artifact has no visualGroup", () => {
    const { container } = render(
      <VisualDiffRailButton artifact={artifact(undefined)} />,
      { wrapper: withNuqsTestingAdapter() },
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the rail trigger with the snapshot name", () => {
    render(<VisualDiffRailButton artifact={artifact(fullGroup())} />, {
      wrapper: withNuqsTestingAdapter(),
    });
    const trigger = screen.getByRole("button", { name: /visual diff/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("landing.png");
  });
});

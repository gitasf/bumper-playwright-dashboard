import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NetworkTab } from "@/trace-viewer/components/network-tab";
import {
  makeBridge,
  makeContext,
  makeModel,
  makeResource,
  makeTabProps,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Component tests for the Network detail tab — the HAR entry list, the
 * request detail panel (headers/timing/bodies), action-window scoping, and
 * the binary-body regression guard (mime, not size, decides text-eligibility)
 * — against the shared synthetic fixture (`trace-viewer-fixture.ts`).
 */

let restoreDomStubs: () => void;

beforeEach(() => {
  // Shared happy-dom gap stubs — see trace-viewer-test-env.ts for the
  // rationale behind each option.
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    objectUrl: true,
    scrollIntoView: true,
    pointerCapture: true,
    getAnimations: true,
  });
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

describe("NetworkTab", () => {
  it("renders both HAR entries, flagging the 500 response as failing", () => {
    render(<NetworkTab {...makeTabProps()} />);
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("checkout")).toBeTruthy();
    expect(
      screen
        .getByText("500")
        .closest("[data-status]")!
        .getAttribute("data-status"),
    ).toBe("fail");
  });

  it("opens a request detail panel on row click and closes it via the X button", async () => {
    const user = userEvent.setup();
    const { container } = render(<NetworkTab {...makeTabProps()} />);
    await user.click(screen.getByText("items"));
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Request headers")).toBeTruthy();
    // Timing legend: SSL is -1 (unset) and skipped; the rest render as
    // "<Label> <value>ms" text spread across sibling text nodes, so assert
    // against the panel's flattened text rather than a single element match.
    expect(container.textContent).toContain("DNS 1.0ms");
    expect(container.textContent).toContain("Wait 6.0ms");

    await user.click(
      screen.getByRole("button", { name: /close request details/i }),
    );
    expect(screen.queryByText("General")).toBeNull();
  });

  it("pretty-prints a JSON request body", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    await user.click(screen.getByText("checkout"));
    expect(screen.getByText("Request body")).toBeTruthy();
    expect(screen.getByText(/"total":\s*12/)).toBeTruthy();
  });

  it("resolves and pretty-prints a JSON response body via the bridge", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({ "sha1/bodysha1.json": '{"a":1}' });
    render(<NetworkTab {...makeTabProps({ bridge })} />);
    await user.click(screen.getByText("items"));
    expect(await screen.findByText(/"a":\s*1/)).toBeTruthy();
  });

  it("scopes rows to the selected action's window", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@2")!;
    render(
      <NetworkTab
        {...makeTabProps({ model, selectedAction, scopeToSelected: true })}
      />,
    );
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.queryByText("checkout")).toBeNull();
  });

  it("filters rows to the timeline selection window", () => {
    // Fixture requests start at _monotonicTime 2100 (items) / 3600
    // (checkout) — only the first falls inside the window.
    render(
      <NetworkTab
        {...makeTabProps({ selection: { start: 2000, end: 3000 } })}
      />,
    );
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.queryByText("checkout")).toBeNull();
  });

  it("shows a selection-empty message when the window has no requests", () => {
    render(
      <NetworkTab
        {...makeTabProps({ selection: { start: 4500, end: 4900 } })}
      />,
    );
    expect(
      screen.getByText("No requests in the selected timeline range."),
    ).toBeTruthy();
  });

  it("filters rows by URL substring via the search field", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    await user.type(
      screen.getByRole("searchbox", { name: /filter requests/i }),
      "checkout",
    );
    expect(screen.getByText("checkout")).toBeTruthy();
    expect(screen.queryByText("items")).toBeNull();

    await user.clear(
      screen.getByRole("searchbox", { name: /filter requests/i }),
    );
    expect(screen.getByText("items")).toBeTruthy();
  });

  it("filters rows by resource type via the type tabs, falling back to mime when _resourceType is absent", async () => {
    const user = userEvent.setup();
    const context = makeContext();
    // No _resourceType — classification must fall back to the CSS mime type.
    const cssResource = makeResource({
      url: "https://app.example/styles/site.css",
      startedDateTime: "2026-07-10T00:00:03.000Z",
      time: 3,
      mimeType: "text/css",
      contentSize: 120,
      timings: {
        dns: -1,
        connect: -1,
        ssl: -1,
        send: 0.5,
        wait: 1,
        receive: 1,
      },
      monotonicTime: 4100,
    });
    const model = makeModel({
      resources: [...context.resources, cssResource],
    });
    render(<NetworkTab {...makeTabProps({ model })} />);

    // Both fixture entries carry _resourceType fetch/xhr → the Fetch tab.
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("checkout")).toBeTruthy();
    expect(screen.queryByText("site.css")).toBeNull();

    await user.click(screen.getByRole("button", { name: "CSS" }));
    expect(screen.getByText("site.css")).toBeTruthy();
    expect(screen.queryByText("items")).toBeNull();

    // A type with no entries keeps the toolbar and shows the inline empty.
    await user.click(screen.getByRole("button", { name: "Image" }));
    expect(screen.getByText("No matching requests.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("site.css")).toBeTruthy();
  });

  it("opens the detail panel from the keyboard via the row's disclosure button", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    const rowButton = screen.getByRole("button", { name: "items" });
    expect(rowButton.getAttribute("aria-expanded")).toBe("false");

    rowButton.focus();
    await user.keyboard("{Enter}");
    expect(rowButton.getAttribute("aria-expanded")).toBe("true");
    // aria-controls points at the now-mounted detail panel.
    const panelId = rowButton.getAttribute("aria-controls")!;
    expect(document.getElementById(panelId)).toBeTruthy();
    expect(screen.getByText("General")).toBeTruthy();

    await user.keyboard("{Enter}");
    expect(rowButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("General")).toBeNull();
  });

  it("returns focus to the row's button when the detail panel is closed via its X", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    const rowButton = screen.getByRole("button", { name: "items" });
    await user.click(rowButton);
    await user.click(
      screen.getByRole("button", { name: /close request details/i }),
    );
    expect(screen.queryByText("General")).toBeNull();
    expect(document.activeElement).toBe(rowButton);
  });

  it("puts Name first and cycles a header's sort asc → desc → natural order", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    const nameHeader = () => screen.getAllByRole("columnheader")[0]!;
    expect(nameHeader().textContent).toContain("Name");
    const firstRowText = () => screen.getAllByRole("row")[1]!.textContent ?? "";

    // Natural (request-start) order: items before checkout.
    expect(firstRowText()).toContain("items");

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(nameHeader().getAttribute("aria-sort")).toBe("ascending");
    expect(firstRowText()).toContain("checkout");

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(nameHeader().getAttribute("aria-sort")).toBe("descending");
    expect(firstRowText()).toContain("items");

    // Third click clears the sort back to natural order.
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(nameHeader().getAttribute("aria-sort")).toBeNull();
    expect(firstRowText()).toContain("items");
  });

  it("sorts numeric columns numerically (duration desc puts the slowest first)", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    await user.click(screen.getByRole("button", { name: "Duration" }));
    await user.click(screen.getByRole("button", { name: "Duration" }));
    // checkout (40ms) over items (12.5ms).
    expect(screen.getAllByRole("row")[1]!.textContent).toContain("checkout");
  });

  it("closes the detail panel when the selected row is filtered out", async () => {
    const user = userEvent.setup();
    render(<NetworkTab {...makeTabProps()} />);
    await user.click(screen.getByText("items"));
    expect(screen.getByText("General")).toBeTruthy();
    await user.type(
      screen.getByRole("searchbox", { name: /filter requests/i }),
      "checkout",
    );
    expect(screen.queryByText("General")).toBeNull();
  });

  it("never fetches a small non-text response body as text (mime, not size, decides text-eligibility)", async () => {
    const user = userEvent.setup();
    const context = makeContext();
    const binaryResource = makeResource({
      url: "https://app.example/api/thumb.bin",
      startedDateTime: "2026-07-10T00:00:03.000Z",
      time: 5,
      mimeType: "application/octet-stream",
      contentSize: 32,
      sha1: "binarysha1.bin",
      timings: {
        dns: -1,
        connect: -1,
        ssl: -1,
        send: 0.5,
        wait: 2,
        receive: 1,
      },
      monotonicTime: 4000,
      resourceType: "fetch",
    });
    const model = makeModel({
      resources: [...context.resources, binaryResource],
    });
    // A small (32-byte) but non-text body: the pre-fix `isTextLike` check
    // OR'd in `content.size < TEXT_PREVIEW_MAX_BYTES`, which would have
    // fetched and `.text()`'d this binary body. If that regresses, this
    // response would show up in `bridge.calls`.
    const bridge = makeBridge({
      "sha1/binarysha1.bin": "should never be fetched as text",
    });
    render(<NetworkTab {...makeTabProps({ model, bridge })} />);
    await user.click(screen.getByText("thumb.bin"));
    expect(screen.getByText(/Preview not available/)).toBeTruthy();
    expect(bridge.calls).toEqual([]);
  });
});

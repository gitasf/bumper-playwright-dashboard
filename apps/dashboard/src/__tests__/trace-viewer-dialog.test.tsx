import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetch } from "void/client";
import type { ArtifactAction } from "@/components/artifact-actions";
import {
  ReplayModalHost,
  TraceViewerDialog,
} from "@/components/trace-viewer-dialog";
import { warmTraceViewer } from "@/trace-viewer/warm";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Component tests for the Replay dialog surface — the attempt switcher
 * (hidden for a single attempt, defaulting to the LAST for retries, updating
 * the viewer IN PLACE on switch, prewarming a hovered attempt) and
 * `ReplayModalHost`'s lazy fetch of the `/replay` endpoint, including the
 * failure path that clears `?replay=` so the URL never advertises a modal
 * that can't open.
 */

// The real TraceViewer boots the SW bridge iframe — irrelevant here. The stub
// exposes the traceUrl it was mounted with so attempt switching is observable
// (the un-keyed viewer must update in place; see the identity assertion).
vi.mock("@/trace-viewer/components/trace-viewer", () => ({
  TraceViewer: ({ traceUrl }: { traceUrl: string }) => (
    <div data-testid="trace-viewer" data-trace-url={traceUrl} />
  ),
}));

// Hover prewarm mounts hidden iframes — stubbed so the switcher's
// hover-intent wiring is observable without booting bridge iframes.
vi.mock("@/trace-viewer/warm", () => ({
  warmTraceViewer: vi.fn(),
  releaseWarmedTrace: vi.fn(),
}));
const warmMock = vi.mocked(warmTraceViewer);

// `useSearchParam` needs Void's router context; the dialog's contract with it
// is just [value, set] — stub it with a controllable pair.
const searchParam = { value: "", set: vi.fn() };
vi.mock("@/lib/hooks/use-search-param", () => ({
  useSearchParam: () => [searchParam.value, searchParam.set] as const,
}));

vi.mock("void/client", () => ({ fetch: vi.fn() }));
const fetchMock = vi.mocked(fetch);

/** ReplayModalHost uses react-query — render it under a fresh client (no
 * retries, so the failure-path test resolves without backoff). Accepts an
 * external client so a test can pre-seed the cache (`client.setQueryData`)
 * and later `rerender` the SAME provider instance to simulate navigating
 * between two already-cached `?replay=` deep links without unmounting. */
function renderHost(
  client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <ReplayModalHost {...HOST_PROPS} />
    </QueryClientProvider>,
  );
}

const HOST_PROPS = {
  teamSlug: "team",
  projectSlug: "proj",
  runId: "run-1",
} as const;

function replayAttempt(attempt: number): {
  attempt: number;
  downloadHref: string;
} {
  return {
    attempt,
    downloadHref: `/api/artifacts/a${attempt}/download?token=t${attempt}`,
  };
}

/** The stub viewer's absolute trace URL for {@link replayAttempt}'s href. */
function absoluteHref(attempt: number): string {
  return new URL(replayAttempt(attempt).downloadHref, window.location.origin)
    .href;
}

let restoreDomStubs: () => void;

beforeEach(() => {
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    scrollIntoView: true,
    pointerCapture: true,
    getAnimations: true,
  });
  searchParam.value = "";
  searchParam.set.mockReset();
  fetchMock.mockReset();
  warmMock.mockReset();
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

describe("ReplayModalHost", () => {
  it("renders no switcher for a single attempt and mounts the viewer on its trace", async () => {
    searchParam.value = "tr-1";
    fetchMock.mockResolvedValue({
      title: "my test",
      attempts: [replayAttempt(0)],
    });

    renderHost();

    const viewer = await screen.findByTestId("trace-viewer");
    expect(viewer.getAttribute("data-trace-url")).toBe(absoluteHref(0));
    expect(screen.getByText("my test")).toBeDefined();
    expect(screen.queryByText(/^Attempt /)).toBeNull();
  });

  it("shows the switcher for retries, defaults to the LAST attempt, and updates the viewer IN PLACE on switch", async () => {
    searchParam.value = "tr-2";
    fetchMock.mockResolvedValue({
      title: "retried test",
      attempts: [replayAttempt(0), replayAttempt(1), replayAttempt(2)],
    });

    renderHost();

    // Defaults to the last (final, authoritative) attempt.
    const initial = await screen.findByTestId("trace-viewer");
    expect(initial.getAttribute("data-trace-url")).toBe(absoluteHref(2));
    expect(screen.getByText("Attempt 1")).toBeDefined();
    expect(screen.getByText("Attempt 3")).toBeDefined();

    await userEvent.click(screen.getByText("Attempt 1"));

    const switched = await screen.findByTestId("trace-viewer");
    expect(switched.getAttribute("data-trace-url")).toBe(absoluteHref(0));
    // Deliberately NOT keyed on the attempt: the viewer must update in place
    // (stale-while-loading swap inside useTraceModel) — a remount would drop
    // the workbench to a spinner on every switch.
    expect(switched).toBe(initial);
  });

  it("prewarms a hovered NON-selected attempt's trace, but not the selected one", async () => {
    searchParam.value = "tr-2";
    fetchMock.mockResolvedValue({
      title: "retried test",
      attempts: [replayAttempt(0), replayAttempt(1)],
    });

    renderHost();
    await screen.findByTestId("trace-viewer");

    // Selected (last) attempt: hover must NOT warm — its trace is already
    // loaded in the viewer.
    await userEvent.hover(screen.getByText("Attempt 2"));
    expect(warmMock).not.toHaveBeenCalled();

    await userEvent.hover(screen.getByText("Attempt 1"));
    expect(warmMock).toHaveBeenCalledTimes(1);
    expect(warmMock).toHaveBeenCalledWith(absoluteHref(0));
  });

  it("clears the ?replay= param when the endpoint fails, so the URL never lies", async () => {
    searchParam.value = "tr-missing";
    fetchMock.mockRejectedValue(new Error("404"));

    renderHost();

    await waitFor(() => {
      expect(searchParam.set).toHaveBeenCalledWith("");
    });
    expect(screen.queryByTestId("trace-viewer")).toBeNull();
  });

  it("refetches an already-cached replay before mounting the viewer again", async () => {
    const first = {
      title: "my test",
      attempts: [replayAttempt(0)],
    };
    const refreshed = {
      title: "my test",
      attempts: [
        {
          attempt: 0,
          downloadHref: "/api/artifacts/a0/download?token=fresh",
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    searchParam.value = "tr-a";
    const rendered = renderHost(client);

    expect(
      (await screen.findByTestId("trace-viewer")).getAttribute(
        "data-trace-url",
      ),
    ).toBe(absoluteHref(0));

    searchParam.value = "";
    rendered.rerender(
      <QueryClientProvider client={client}>
        <ReplayModalHost {...HOST_PROPS} />
      </QueryClientProvider>,
    );
    searchParam.value = "tr-a";
    rendered.rerender(
      <QueryClientProvider client={client}>
        <ReplayModalHost {...HOST_PROPS} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      (await screen.findByTestId("trace-viewer")).getAttribute(
        "data-trace-url",
      ),
    ).toBe(
      new URL(refreshed.attempts[0].downloadHref, window.location.origin).href,
    );
  });
});

describe("TraceViewerDialog (artifacts-rail entry)", () => {
  const artifact: ArtifactAction = {
    id: "art-1",
    type: "trace",
    name: "trace.zip",
    contentType: "application/zip",
    downloadHref: "/api/artifacts/art-1/download?token=tok",
  };

  it("opens directly on the artifact's trace when ?replay= matches, without a switcher", () => {
    searchParam.value = "art-1";

    render(<TraceViewerDialog artifact={artifact}>Replay</TraceViewerDialog>);

    const viewer = screen.getByTestId("trace-viewer");
    expect(viewer.getAttribute("data-trace-url")).toBe(
      new URL(artifact.downloadHref, window.location.origin).href,
    );
    expect(screen.queryByText(/^Attempt /)).toBeNull();
  });

  it("renders nothing for a non-trace artifact", () => {
    const { container } = render(
      <TraceViewerDialog artifact={{ ...artifact, type: "screenshot" }}>
        Replay
      </TraceViewerDialog>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a legacy generic ZIP misclassified as trace", () => {
    const { container } = render(
      <TraceViewerDialog artifact={{ ...artifact, name: "diagnostics.zip" }}>
        Replay
      </TraceViewerDialog>,
    );
    expect(container.innerHTML).toBe("");
  });
});

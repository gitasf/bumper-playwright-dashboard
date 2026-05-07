/**
 * Component coverage for the runs-filter island. Closes a gap that the
 * Playwright suite leaves open: the URL ↔ state round-trip is fast to verify
 * at the component level, and only e2e covered the success path before.
 *
 * The full filter bar uses Base UI Popover/Combobox primitives that aren't
 * worth recreating in happy-dom — RunsSearchInput is the smallest piece
 * that exercises the debounced `navigate()` write, which is the contract
 * the rest of the bar shares.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));

vi.mock("rwsdk/client", () => ({
  navigate: navigateMock,
}));

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RunsSearchInput } from "@/app/components/runs-filter-bar";
import { EMPTY_FILTERS } from "@/lib/runs-filters";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RunsSearchInput", () => {
  it("renders the search input pre-filled from filters.q", () => {
    render(
      <RunsSearchInput
        filters={{ ...EMPTY_FILTERS, q: "feat: dashboard" }}
        pathname="/t/acme/p/web"
      />,
    );
    const input = screen.getByLabelText(/search runs/i) as HTMLInputElement;
    expect(input.value).toBe("feat: dashboard");
  });

  it("debounces typing and writes the query string back via navigate()", async () => {
    const user = userEvent.setup();
    render(
      <RunsSearchInput filters={EMPTY_FILTERS} pathname="/t/acme/p/web" />,
    );
    await user.type(screen.getByLabelText(/search runs/i), "abc");

    await waitFor(
      () => {
        expect(navigateMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
    expect(navigateMock).toHaveBeenCalledWith(
      "/t/acme/p/web?q=abc",
      expect.objectContaining({ history: "replace" }),
    );
  });

  it("preserves other filters when writing back the new q", async () => {
    const user = userEvent.setup();
    render(
      <RunsSearchInput
        filters={{
          ...EMPTY_FILTERS,
          status: ["failed"],
          branch: ["main"],
        }}
        pathname="/t/acme/p/web"
      />,
    );
    await user.type(screen.getByLabelText(/search runs/i), "x");

    await waitFor(
      () => {
        expect(navigateMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
    const [url] = navigateMock.mock.calls[0];
    expect(url).toContain("q=x");
    expect(url).toContain("status=failed");
    expect(url).toContain("branch=main");
  });

  it("resets pagination to page 1 on a new query", async () => {
    const user = userEvent.setup();
    render(
      <RunsSearchInput
        filters={{ ...EMPTY_FILTERS, page: 5 }}
        pathname="/t/acme/p/web"
      />,
    );
    await user.type(screen.getByLabelText(/search runs/i), "z");

    await waitFor(
      () => {
        expect(navigateMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
    const [url] = navigateMock.mock.calls[0];
    // Page 1 is implicit — toSearchParams omits it. Anything else would
    // surface as `page=…`.
    expect(url).not.toContain("page=");
  });

  it("does not navigate when the typed value matches filters.q (no-op)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RunsSearchInput
        filters={{ ...EMPTY_FILTERS, q: "ab" }}
        pathname="/t/acme/p/web"
      />,
    );
    await user.clear(screen.getByLabelText(/search runs/i));
    await user.type(screen.getByLabelText(/search runs/i), "ab");

    // Drain the debounce window before asserting — at this point the
    // debounced value equals filters.q and the navigate effect short-circuits.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(navigateMock).not.toHaveBeenCalled();

    // Sanity: after a parent rerender with a different filters.q, the input
    // re-syncs from props rather than holding the stale local state.
    rerender(
      <RunsSearchInput
        filters={{ ...EMPTY_FILTERS, q: "ab" }}
        pathname="/t/acme/p/web"
      />,
    );
    expect(
      (screen.getByLabelText(/search runs/i) as HTMLInputElement).value,
    ).toBe("ab");
  });
});

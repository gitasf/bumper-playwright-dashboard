import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import { forwardRef } from "react";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { TablePaginationFooterSkeleton } from "@/components/skeletons";

// The footer's links use the Void router in the application. A native anchor
// keeps this component test focused on the generated pager hrefs and states.
vi.mock("@/components/ui/link", () => ({
  Link: forwardRef<HTMLAnchorElement, React.ComponentProps<"a">>(
    function TestLink(props, ref) {
      return <a ref={ref} {...props} />;
    },
  ),
}));

afterEach(cleanup);

describe("TablePaginationFooter", () => {
  it("renders offset pagination as previous/next links without page numbers", () => {
    render(
      <TablePaginationFooter
        currentPage={2}
        fromRow={51}
        itemNoun="test"
        pageHref={(page) => `/tests?page=${page}`}
        toRow={100}
        totalCount={180}
        totalPages={4}
      />,
    );

    expect(screen.getByText("Page 2 of 4")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Go to previous page" })
        .getAttribute("href"),
    ).toBe("/tests?page=1");
    expect(
      screen
        .getByRole("link", { name: "Go to next page" })
        .getAttribute("href"),
    ).toBe("/tests?page=3");
    expect(screen.queryByRole("link", { name: "2" })).toBeNull();
  });

  it("disables the unavailable direction on an offset boundary", () => {
    render(
      <TablePaginationFooter
        currentPage={1}
        fromRow={1}
        itemNoun="event"
        pageHref={(page) => `/audit?page=${page}`}
        toRow={50}
        totalCount={51}
        totalPages={2}
      />,
    );

    expect(
      screen
        .getByLabelText("Go to previous page")
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("link", { name: "Go to next page" })
        .getAttribute("href"),
    ).toBe("/audit?page=2");
  });

  it("reserves the pager height for unpaginated and loading footers", () => {
    const footer = render(
      <TablePaginationFooter
        fromRow={1}
        itemNoun="monitor"
        toRow={3}
        totalCount={3}
      />,
    );
    expect(footer.container.firstElementChild?.classList).toContain("min-h-15");
    expect(footer.container.firstElementChild?.classList).toContain(
      "sm:min-h-14",
    );
    footer.unmount();

    const skeleton = render(<TablePaginationFooterSkeleton />);
    expect(skeleton.container.firstElementChild?.classList).toContain(
      "min-h-15",
    );
    expect(skeleton.container.firstElementChild?.classList).toContain(
      "sm:min-h-14",
    );
  });
});

import { Link } from "@/components/ui/link";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { cn } from "@/lib/cn";

export interface TablePaginationFooterProps {
  /** 1-indexed start row of the current page (0 when there are no items). */
  fromRow: number;
  /** 1-indexed end row of the current page (0 when there are no items). */
  toRow: number;
  /** Total item count across all pages. */
  totalCount: number;
  /** Singular noun used in the summary, e.g. `"test"` → "tests". */
  itemNoun: string;
  /**
   * Offset-page wiring. The footer derives previous/next links from these
   * values; omit all three for unpaginated lists. Mutually exclusive with
   * `prevHref`/`nextHref` (a table is either offset- or keyset-paginated, never
   * both). `currentPage`/`totalPages` without `pageHref` supply the cursor
   * mode's "Page X of Y" label.
   */
  currentPage?: number;
  totalPages?: number;
  pageHref?: (page: number) => string;
  /**
   * Keyset/cursor pagination — a prev/next strip with no numbered links; pass
   * `currentPage`/`totalPages` for the "Page X of Y" label. `null` disables that
   * direction (greyed out); omit both to skip the nav strip.
   */
  prevHref?: string | null;
  nextHref?: string | null;
  /** Override the wrapper class, e.g. for in-card embedding. */
  className?: string;
}

/**
 * Footer strip for tables: "Showing X–Y of N items" on the left and a shared
 * previous/next pager on the right when the list is paginated.
 *
 * The minimum height includes enough room for the pager even when a list is
 * unpaginated, so table footers do not change height between pages.
 */
export function TablePaginationFooter({
  fromRow,
  toRow,
  totalCount,
  currentPage,
  totalPages,
  itemNoun,
  pageHref,
  prevHref,
  nextHref,
  className,
}: TablePaginationFooterProps): React.ReactElement {
  const plural = totalCount === 1 ? itemNoun : `${itemNoun}s`;
  const offsetPaginated =
    pageHref != null &&
    currentPage != null &&
    totalPages != null &&
    totalPages > 1;
  const cursorPaginated =
    (prevHref !== undefined || nextHref !== undefined) &&
    (prevHref != null || nextHref != null);
  const showPager = offsetPaginated || cursorPaginated;
  const resolvedPrevHref = offsetPaginated
    ? currentPage > 1
      ? pageHref(currentPage - 1)
      : null
    : prevHref;
  const resolvedNextHref = offsetPaginated
    ? currentPage < totalPages
      ? pageHref(currentPage + 1)
      : null
    : nextHref;

  return (
    <div
      className={cn(
        "flex min-h-15 items-center justify-between gap-4 border-t border-line-1 shrink-0 px-6 py-3 text-xs font-mono text-fg-3 sm:min-h-14",
        className,
      )}
    >
      <span>
        {totalCount === 0
          ? `No ${plural}`
          : `Showing ${fromRow}–${toRow} of ${totalCount.toLocaleString()} ${plural}`}
      </span>
      {showPager && (
        <div className="flex items-center gap-3">
          {currentPage != null && totalPages != null && totalPages > 1 && (
            <span>
              Page {currentPage.toLocaleString()} of{" "}
              {totalPages.toLocaleString()}
            </span>
          )}
          <PaginationStrip
            nextHref={resolvedNextHref}
            prevHref={resolvedPrevHref}
          />
        </div>
      )}
    </div>
  );
}

/** The shared prev/next-only strip for offset- and keyset-paginated tables. */
function PaginationStrip({
  prevHref,
  nextHref,
}: {
  prevHref?: string | null;
  nextHref?: string | null;
}): React.ReactElement {
  return (
    <Pagination className="mx-0 w-auto justify-end">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={prevHref ?? undefined}
            render={prevHref ? <Link href={prevHref} /> : undefined}
            aria-disabled={!prevHref}
            className={cn(!prevHref && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href={nextHref ?? undefined}
            render={nextHref ? <Link href={nextHref} /> : undefined}
            aria-disabled={!nextHref}
            className={cn(!nextHref && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

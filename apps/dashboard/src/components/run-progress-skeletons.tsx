import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading-state skeletons for the run-detail Tests tab (`<RunProgress>`): a
 * group-header bar and the row placeholders shown while an expanded group's rows
 * load. Each mirrors the real element's box so streaming in the data causes no
 * layout shift. Pure presentational — no client hooks.
 */

/** One skeleton group-header bar (matches the `TestGroup` header layout). */
export function GroupHeaderSkeleton() {
  return (
    <div
      aria-hidden
      className="flex items-center gap-2 border-b border-line-1 px-6 py-[11px]"
    >
      <Skeleton className="size-3 rounded-full" />
      <Skeleton className="h-3 w-[220px]" />
      <div className="flex-1" />
      <Skeleton className="h-3 w-12" />
    </div>
  );
}

/** Skeleton group-header bars for the initial group-list load. */
export function TestsListSkeleton() {
  return (
    <div aria-hidden>
      {["s0", "s1", "s2", "s3", "s4", "s5"].map((k) => (
        <GroupHeaderSkeleton key={k} />
      ))}
    </div>
  );
}

/** Skeleton test-rows shown while an expanded group's rows load. */
export function GroupRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => `r${i}`).map((k) => (
        <div
          className="flex min-h-8 items-center gap-2 py-1.5 pl-[50px] pr-6"
          key={k}
        >
          <Skeleton className="size-3 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-[240px]" />
        </div>
      ))}
    </div>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { fetch } from "void/client";
import { Link } from "@void/react";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { statusLabel, statusToken } from "@/lib/status";

type Variant = "failed" | "flaky" | "passed" | "skipped";

type Props = {
  variant: Variant;
  count: number;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  runHref: string;
};

const TRIGGER_CLASS =
  "relative z-10 inline-flex shrink-0 cursor-pointer items-center font-mono text-[11px] tabular-nums outline-none transition-colors hover:underline focus-visible:underline";

/** Sentence-case (lowercase) label for inline use, e.g. "2 failed tests". */
function variantLabel(variant: Variant): string {
  return statusLabel(variant).toLowerCase();
}

function fetchTestPreview(
  teamSlug: string,
  projectSlug: string,
  runId: string,
) {
  return fetch("/api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview", {
    params: { teamSlug, projectSlug, runId },
  });
}

export function RunTestsPopover({
  variant,
  count,
  teamSlug,
  projectSlug,
  runId,
  runHref,
}: Props): React.ReactElement | null {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const queryKey = ["run-test-preview", teamSlug, projectSlug, runId] as const;

  const prefetch = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () => fetchTestPreview(teamSlug, projectSlug, runId),
      staleTime: 15_000,
    });
  }, [queryClient, queryKey, teamSlug, projectSlug, runId]);

  const { data, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchTestPreview(teamSlug, projectSlug, runId),
    enabled: isOpen,
    staleTime: 15_000,
  });

  if (count === 0) return null;

  const items = data?.[variant];
  const isLoading = isOpen && !data && !isError;

  return (
    <Popover onOpenChange={setIsOpen}>
      <PopoverTrigger
        className={TRIGGER_CLASS}
        onFocus={prefetch}
        onPointerEnter={prefetch}
        style={{ color: statusToken(variant) }}
      >
        {count}
      </PopoverTrigger>
      <PopoverPopup className="w-96 p-0" align="start" side="bottom">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-semibold tracking-tight">
            {isLoading || !items
              ? `${count} ${variantLabel(variant)} tests`
              : `Showing ${items.length} of ${count} ${variantLabel(variant)} tests`}
          </h3>
        </div>

        {isError ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            <p>Couldn't load tests.</p>
            <button
              type="button"
              className="mt-2 font-mono text-[11px] underline hover:text-foreground"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </div>
        ) : isLoading || !items ? (
          <ul className="divide-y divide-border/60">
            {[0, 1, 2].map((i) => (
              <li key={i} className="px-4 py-2.5">
                <div className="h-3 w-3/4 rounded-sm bg-muted animate-pulse" />
                <div className="mt-1.5 h-2.5 w-1/2 rounded-sm bg-muted/60 animate-pulse" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No {variantLabel(variant)} tests found.
          </div>
        ) : (
          <ul className="divide-y divide-border/60 max-h-80 overflow-y-auto">
            {items.map((item) => {
              const testHref = `${runHref}/tests/${item.id}`;
              return (
                <li key={item.id}>
                  <Link
                    href={testHref}
                    className="block px-4 py-2.5 hover:bg-muted/40 transition-colors"
                  >
                    <div className="text-xs font-medium truncate">
                      {item.title}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground truncate">
                      {item.projectName ? `${item.projectName} · ` : ""}
                      {item.file}
                    </div>
                    {variant === "failed" && item.errorMessage ? (
                      <div className="mt-1 font-mono text-[11px] text-destructive-foreground/80 line-clamp-2">
                        {item.errorMessage}
                      </div>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <div className="px-4 py-2.5 border-t border-border bg-muted/20">
          <Link
            href={runHref}
            className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
          >
            View full report
            <ArrowRight size={12} strokeWidth={2} />
          </Link>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

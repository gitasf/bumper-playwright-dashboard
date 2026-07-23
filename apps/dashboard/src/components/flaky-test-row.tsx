import { PREFETCH_STABLE } from "@/components/ui/link";
import { RowLink } from "@/components/row-link";
import type React from "react";
import { OwnerCell, type OwnerChip } from "@/components/owner-cell";
import { Sparkline, type SparklinePoint } from "@/components/sparkline";
import { StatusGlyph } from "@/components/status-glyph";
import { TableCell, TableRow } from "@/components/ui/table";
import { stripAnsi } from "@/lib/ansi";
import { formatRelativeTime } from "@/lib/time-format";

export interface FlakyRecentFailure {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  actor: string | null;
  createdAt: number;
  errorMessage: string | null;
}

export interface FlakyTestRowProps {
  title: string;
  file: string;
  tags: string[];
  pct: number;
  rangeDays: number;
  sparklinePoints: SparklinePoint[];
  recentFailures: FlakyRecentFailure[];
  /** Where the row click lands — typically the most recent failure's
   * test-detail page, falling back to the project base. */
  rowHref: string;
  /** Resolved owners for this test (manual + CODEOWNERS, manual-wins). */
  owners: OwnerChip[];
}

function pctTone(pct: number): string {
  if (pct >= 20) return "var(--fail)";
  if (pct >= 5) return "var(--flaky)";
  return "var(--fg-3)";
}

/**
 * Strip the file path prefix from the title if Playwright captured it
 * that way. Our reporter sometimes stores titles like
 * `"flaky.spec.ts > Promo codes > validates …"`; the design wants just
 * `"Promo codes > validates …"` on the top line.
 */
function displayTitle(title: string, file: string): string {
  if (!file) return title;
  const prefix = `${file} > `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

/**
 * Flaky test row. Layout mirrors the design bundle's `FlakyRow`
 * (`wrightful/project/screen-flaky-tests.jsx:84-122`), with an Owner column
 * showing the test's ownership chips read-only (assignment lives in the
 * per-test page's popover, roadmap 2.3):
 *   [glyph 40] [Test flex] [Flake rate 110 r] [Nd trend 180] [Last failure 280] [Owner 210] [Last seen 90 r]
 *
 * Test cell is two lines:
 *   - Line 1 (sans 13px, weight 450): describe-path + test title.
 *   - Line 2 (mono 11px muted): file path + tags inline (`gap: 8`).
 * Tags pick up `var(--running)` (the indigo accent — same hex the
 * design's `--accent` token holds).
 *
 * X-padding matches the runs table (`px-4`).
 */
export function FlakyTestRow({
  title,
  file,
  tags,
  pct,
  rangeDays,
  sparklinePoints,
  recentFailures,
  rowHref,
  owners,
}: FlakyTestRowProps): React.ReactElement {
  const tone = pctTone(pct);
  const latest = recentFailures[0];
  const cleanTitle = displayTitle(title, file);

  return (
    <TableRow>
      <TableCell className="w-10 px-4 align-middle">
        <RowLink cacheFor={PREFETCH_STABLE} href={rowHref}>
          <span className="sr-only">View {cleanTitle}</span>
          <StatusGlyph size={14} status="flaky" />
        </RowLink>
      </TableCell>
      <TableCell className="px-4 py-3 align-middle">
        <div className="min-w-0">
          <div
            className="truncate text-body font-[450] text-fg-1"
            title={cleanTitle}
          >
            {cleanTitle}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-micro text-fg-3">
            <span className="min-w-0 truncate" title={file}>
              {file}
            </span>
            {tags.map((t) => (
              <span
                className="shrink-0"
                key={t}
                style={{ color: "var(--running)" }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </TableCell>
      <TableCell className="w-[110px] px-4 py-3 text-right align-middle">
        <div
          className="font-mono text-body font-semibold tabular-nums"
          style={{ color: tone }}
        >
          {pct.toFixed(0)}%
        </div>
        <div className="mt-0.5 text-micro text-fg-3">over {rangeDays}d</div>
      </TableCell>
      <TableCell className="w-[180px] px-4 py-3 align-middle">
        <Sparkline height={22} points={sparklinePoints} width={160} />
      </TableCell>
      <TableCell className="w-[280px] max-w-[280px] px-4 py-3 align-middle">
        <div
          className="truncate font-mono text-caption text-fg-3"
          title={latest?.errorMessage ? stripAnsi(latest.errorMessage) : ""}
        >
          {latest?.errorMessage
            ? stripAnsi(latest.errorMessage.split("\n")[0] ?? "")
            : "—"}
        </div>
      </TableCell>
      <TableCell className="w-[210px] px-4 py-3 align-middle">
        <OwnerCell owners={owners} />
      </TableCell>
      <TableCell className="w-[90px] px-4 py-3 text-right align-middle text-caption text-fg-3">
        {latest ? formatRelativeTime(latest.createdAt) : "—"}
      </TableCell>
    </TableRow>
  );
}

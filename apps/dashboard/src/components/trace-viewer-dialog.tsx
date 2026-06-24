"use client";

import { Download, ExternalLink, PlayCircle } from "lucide-react";
import { useState } from "react";
import type { ArtifactAction } from "@/components/artifact-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Shared body of the Test Replay dialog: a near-full-viewport panel whose
 * iframe hosts the self-hosted Playwright trace viewer
 * (`/trace-viewer/index.html?trace=…`, vendored into `public/` — see
 * `scripts/vendor-trace-viewer.mjs`). This gives Cypress-style time-travel (DOM
 * snapshot scrubber + command log + network + console) without leaving the
 * dashboard, and without the trace bytes ever reaching the public
 * trace.playwright.dev.
 *
 * The iframe mounts only while `open` so the ~1.6 MB bundle + service-worker
 * registration defer to first use and a reopened dialog reloads fresh (no stale
 * snapshot from a prior trace). Rendered inside a `<Dialog>` by both call sites:
 * the test-detail artifacts rail (`TraceViewerDialog`, URL known at SSR) and the
 * run's test list (`TestReplayButton`, URL fetched lazily on click).
 */
function TestReplayContent({
  viewerUrl,
  downloadHref,
  title,
  open,
}: {
  viewerUrl: string;
  downloadHref: string;
  title: string;
  open: boolean;
}): React.ReactElement {
  // The viewer URL embeds the absolute signed download URL after `?trace=`.
  // Reuse it verbatim for the public-viewer fallback so both point at the exact
  // same artifact (the download endpoint already CORS-allows that origin).
  const encodedTrace = viewerUrl.split("?trace=")[1] ?? "";
  const publicViewerUrl = encodedTrace
    ? `https://trace.playwright.dev/?trace=${encodedTrace}`
    : null;

  return (
    <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border py-2.5 pr-12 pl-4">
        <DialogTitle className="min-w-0 truncate font-mono text-sm font-medium">
          {title}
        </DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            render={<a href={viewerUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
            New tab
          </Button>
          <Button
            size="sm"
            variant="ghost"
            render={<a href={downloadHref} download />}
          >
            <Download />
            Download
          </Button>
          {publicViewerUrl ? (
            <Button
              size="sm"
              variant="ghost"
              title="Opens the public Playwright viewer — sends this trace to trace.playwright.dev"
              className="text-muted-foreground"
              render={
                <a href={publicViewerUrl} target="_blank" rel="noreferrer" />
              }
            >
              Public viewer
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <iframe
          title={`Test replay: ${title}`}
          src={viewerUrl}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
      ) : null}
    </DialogContent>
  );
}

/**
 * Test-detail artifacts-rail entry point. The trace artifact already carries a
 * signed `traceViewerUrl` (minted in the page loader), so the dialog opens
 * directly. `children` are the trigger's inner content so the rail keeps
 * ownership of the button's appearance.
 */
export function TraceViewerDialog({
  artifact,
  children,
}: {
  artifact: ArtifactAction;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const viewerUrl = artifact.traceViewerUrl;
  if (!viewerUrl) return <></>;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-between"
          />
        }
      >
        {children}
      </DialogTrigger>
      <TestReplayContent
        viewerUrl={viewerUrl}
        downloadHref={artifact.downloadHref}
        title={artifact.name}
        open={open}
      />
    </Dialog>
  );
}

/**
 * Per-row "Test Replay" button for the run's live test list (`RunProgress`).
 * That list carries only minimal per-test rows, so this lazily fetches the
 * signed viewer URL from the replay endpoint on first click, then opens the
 * dialog. Rendered only for tests known to have a trace (the loader's
 * `tracedTestIds`), so the fetch is expected to succeed; a transient failure
 * just leaves the dialog closed.
 */
export function TestReplayButton({
  replayHref,
  title,
}: {
  /** `/api/t/:team/p/:project/runs/:runId/tests/:testResultId/replay`. */
  replayHref: string;
  title: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState<{
    viewerUrl: string;
    downloadHref: string;
  } | null>(null);

  async function onClick(): Promise<void> {
    if (resolved) {
      setOpen(true);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(replayHref);
      if (!res.ok) return;
      const body = await res.json();
      if (
        body &&
        typeof body === "object" &&
        "traceViewerUrl" in body &&
        "downloadHref" in body &&
        typeof body.traceViewerUrl === "string" &&
        typeof body.downloadHref === "string"
      ) {
        setResolved({
          viewerUrl: body.traceViewerUrl,
          downloadHref: body.downloadHref,
        });
        setOpen(true);
      }
    } catch {
      // Best-effort — the button just doesn't open. The trace is still
      // reachable from the test-detail page's artifacts rail.
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        disabled={loading}
        onClick={(e) => {
          // The row is a <Link>; don't navigate when opening the replay.
          e.preventDefault();
          e.stopPropagation();
          void onClick();
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary opacity-80 transition hover:bg-primary/10 hover:opacity-100 disabled:opacity-50"
      >
        <PlayCircle className="size-3.5" strokeWidth={2} />
        Test Replay
      </button>
      {resolved ? (
        <TestReplayContent
          viewerUrl={resolved.viewerUrl}
          downloadHref={resolved.downloadHref}
          title={title}
          open={open}
        />
      ) : null}
    </Dialog>
  );
}

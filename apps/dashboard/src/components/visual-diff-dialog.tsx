import { ArrowRight, ImageOff, SquareSplitHorizontal } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import type {
  ArtifactAction,
  VisualDiffFrame,
  VisualDiffGroup,
} from "@/components/artifact-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { useSearchParam } from "@/lib/hooks/use-search-param";

const MODES = ["diff", "expected", "actual", "slider", "side-by-side"] as const;
type Mode = (typeof MODES)[number];

/**
 * The viewing modes a group can offer: a single-image mode needs its own
 * frame; the two comparison modes (`slider`, `side-by-side`) need both the
 * expected and actual frames. Pure so the gating rule can be pinned directly.
 */
export function availableModes(group: VisualDiffGroup): Mode[] {
  const hasBoth = Boolean(group.expected && group.actual);
  return MODES.filter((m) =>
    m === "slider" || m === "side-by-side" ? hasBoth : Boolean(group[m]),
  );
}

/**
 * Trigger + dialog for one Playwright visual snapshot triple
 * (`expected`/`actual`/`diff`). Rail-styled button matches the screenshot /
 * video / trace siblings; the modal mirrors Playwright's HTML reporter
 * layout — three single-image tabs plus a side-by-side comparison.
 *
 * The mode is persisted in `?vmode=` so deep-links to a specific viewing
 * mode work and so the user's preference is sticky across multiple visual
 * diffs in the same test detail page.
 */
export function VisualDiffRailButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  const group = artifact.visualGroup;
  if (!group) return <></>;
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-between"
          />
        }
      >
        <span className="inline-flex items-center gap-2">
          <SquareSplitHorizontal />
          Visual diff
          <span className="text-fg-3 text-xs">{group.snapshotName}</span>
        </span>
        <ArrowRight className="opacity-50" aria-hidden />
      </DialogTrigger>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="font-mono text-sm">
              {group.snapshotName}
            </DialogTitle>
            <Badge variant="error" size="sm">
              Visual diff failed
            </Badge>
          </div>
        </DialogHeader>
        <VisualDiffViewer group={group} />
      </DialogContent>
    </Dialog>
  );
}

export function VisualDiffViewer({
  group,
}: {
  group: VisualDiffGroup;
}): React.ReactElement {
  const [mode, setMode] = useSearchParam("vmode", "diff");
  const tabValues = availableModes(group);
  // If the URL value is missing or names a frame this group doesn't have
  // (e.g. hand-typed `vmode=diff` for a triple that lost its diff), drop
  // back to the first available tab without persisting the change.
  const activeMode: Mode =
    tabValues.find((m) => m === mode) ?? tabValues[0] ?? "diff";

  // Panels are URL-driven off `?vmode=` — only the active one renders.
  return (
    <div className="flex flex-col gap-4 px-6 pb-6">
      <TabBar role="tablist">
        {tabValues.map((m) => (
          <TabBarTab
            active={activeMode === m}
            key={m}
            onSelect={() => {
              setMode(m);
            }}
          >
            {labelFor(m)}
          </TabBarTab>
        ))}
      </TabBar>
      {activeMode === "diff" ? (
        <FrameImage frame={group.diff} alt={`Diff for ${group.snapshotName}`} />
      ) : null}
      {activeMode === "expected" ? (
        <FrameImage
          frame={group.expected}
          alt={`Expected baseline for ${group.snapshotName}`}
        />
      ) : null}
      {activeMode === "actual" ? (
        <FrameImage
          frame={group.actual}
          alt={`Actual capture for ${group.snapshotName}`}
        />
      ) : null}
      {activeMode === "slider" ? (
        <SliderCompare
          expected={group.expected}
          actual={group.actual}
          name={group.snapshotName}
        />
      ) : null}
      {activeMode === "side-by-side" ? (
        <div className="grid grid-cols-2 gap-2">
          <SideBySideFrame
            label="Expected"
            frame={group.expected}
            alt={`Expected baseline for ${group.snapshotName}`}
          />
          <SideBySideFrame
            label="Actual"
            frame={group.actual}
            alt={`Actual capture for ${group.snapshotName}`}
          />
        </div>
      ) : null}
    </div>
  );
}

function labelFor(m: Mode): string {
  if (m === "side-by-side") return "Side-by-side";
  if (m === "slider") return "Slider";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/**
 * Drag-to-compare scrubber: expected on the base layer, actual overlaid and
 * clipped to the right of the handle via `clip-path: inset()`. 1:1 pointer
 * tracking with pointer capture (drag continues off-bounds), plus keyboard
 * control (arrows / Home / End) via `role="slider"`. `clip-path` keeps the
 * wipe on the compositor — no re-layout as the handle moves.
 */
function SliderCompare({
  expected,
  actual,
  name,
}: {
  expected: VisualDiffFrame | null;
  actual: VisualDiffFrame | null;
  name: string;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [pos, setPos] = useState(50);

  if (!expected || !actual) return <FrameMissing />;

  const setFromClientX = (clientX: number): void => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(100, Math.max(0, next)));
  };

  return (
    <div
      ref={containerRef}
      aria-label={`Compare expected and actual for ${name}`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(pos)}
      className="relative w-full touch-none select-none overflow-hidden rounded-md bg-muted outline outline-1 -outline-offset-1 outline-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:outline-white/10"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - 5));
        else if (e.key === "ArrowRight") setPos((p) => Math.min(100, p + 5));
        else if (e.key === "Home") setPos(0);
        else if (e.key === "End") setPos(100);
        else return;
        e.preventDefault();
      }}
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) setFromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      role="slider"
      tabIndex={0}
    >
      <img
        className="block w-full"
        alt={`Expected baseline for ${name}`}
        draggable={false}
        src={expected.href}
      />
      <img
        aria-hidden
        className="absolute inset-0 block size-full"
        style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
        alt=""
        draggable={false}
        src={actual.href}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_--theme(--color-black/40%)]"
        style={{ left: `${pos}%` }}
      >
        <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 flex size-7 items-center justify-center rounded-full bg-white text-black shadow-md">
          <SquareSplitHorizontal className="size-3.5" />
        </span>
      </div>
      <span className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 font-medium text-micro text-white">
        Expected
      </span>
      <span className="pointer-events-none absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 font-medium text-micro text-white">
        Actual
      </span>
    </div>
  );
}

function FrameImage({
  frame,
  alt,
}: {
  frame: VisualDiffFrame | null;
  alt: string;
}): React.ReactElement {
  if (!frame) return <FrameMissing />;
  return (
    <img
      className="w-full rounded-md bg-muted outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      alt={alt}
      src={frame.href}
    />
  );
}

function SideBySideFrame({
  label,
  frame,
  alt,
}: {
  label: string;
  frame: VisualDiffFrame | null;
  alt: string;
}): React.ReactElement {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </figcaption>
      {frame ? (
        <img
          className={cn(
            "w-full rounded-md bg-muted outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
          )}
          alt={alt}
          src={frame.href}
        />
      ) : (
        <FrameMissing />
      )}
    </figure>
  );
}

function FrameMissing(): React.ReactElement {
  return (
    <div className="flex aspect-video w-full items-center justify-center gap-2 rounded-md border border-dashed border-line-1 bg-muted/30 text-fg-3 text-sm">
      <ImageOff className="size-4" aria-hidden />
      Not available
    </div>
  );
}

import {
  ArrowRight,
  Check,
  Copy,
  History,
  ImageIcon,
  Play,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import type { ArtifactAction } from "@/components/artifact-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TraceViewerDialog } from "@/components/trace-viewer-dialog";
import { VisualDiffRailButton } from "@/components/visual-diff-dialog";
import { cn } from "@/lib/cn";
import { useCopiedFlag } from "@/lib/use-copied-flag";

/**
 * Sticky right rail on the test detail page. Three optional sections:
 *   - ARTIFACTS — trace / video / screenshot as full-width vertical buttons
 *   - REPRODUCTION — terminal-styled `npx playwright test …` with a copy
 *     button, plus the optional AI copy-prompt artifact below
 *   - ENVIRONMENT — two-column grid of whatever metadata we have
 *
 * The vertical full-width artifact buttons are implemented locally here. This
 * rail is the only surface that renders artifact actions (the run-detail row
 * has no artifact host), so there is no shared button component to parameterise.
 */
export function ArtifactsRail({
  media,
  copyPrompt,
  reproduceCommand,
  environment,
}: {
  media: ArtifactAction[];
  copyPrompt: ArtifactAction | null;
  reproduceCommand: string | null;
  environment: EnvironmentFields;
}): React.ReactElement | null {
  const envRows = environmentRows(environment);
  const hasArtifacts = media.length > 0;
  const hasRepro = Boolean(reproduceCommand) || Boolean(copyPrompt);
  const hasEnv = envRows.length > 0;
  if (!hasArtifacts && !hasRepro && !hasEnv) return null;
  return (
    <div className="flex flex-col">
      {hasArtifacts ? (
        <section className="p-5 border-b border-border">
          <SectionLabel>Artifacts</SectionLabel>
          <div className="flex flex-col gap-2">
            {media.map((a) => (
              <RailArtifactButton key={a.id} artifact={a} />
            ))}
          </div>
        </section>
      ) : null}
      {hasRepro ? (
        <section className="p-5 border-b border-border">
          <SectionLabel>Reproduction</SectionLabel>
          {reproduceCommand ? (
            <TerminalBlock command={reproduceCommand} />
          ) : null}
          {copyPrompt ? (
            <div className={cn(reproduceCommand ? "mt-3" : "")}>
              <CopyArtifactButton artifact={copyPrompt} />
            </div>
          ) : null}
        </section>
      ) : null}
      {hasEnv ? (
        <section className="p-5">
          <SectionLabel>Environment</SectionLabel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm font-mono">
            {envRows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

export interface EnvironmentFields {
  browser?: string | null;
  workerIndex?: number | null;
  playwrightVersion?: string | null;
}

function environmentRows(env: EnvironmentFields): [string, string][] {
  const rows: [string, string][] = [];
  if (env.browser) rows.push(["Browser", env.browser]);
  if (env.workerIndex != null) rows.push(["Worker", String(env.workerIndex)]);
  if (env.playwrightVersion) rows.push(["Playwright", env.playwrightVersion]);
  return rows;
}

function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <h4 className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-3">
      {children}
    </h4>
  );
}

function RailArtifactButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  switch (artifact.type) {
    case "trace":
      return <RailTraceButton artifact={artifact} />;
    case "visual":
      return <VisualDiffRailButton artifact={artifact} />;
    case "video":
      return <RailVideoButton artifact={artifact} />;
    case "screenshot":
      return <RailScreenshotButton artifact={artifact} />;
    default:
      return <></>;
  }
}

function railButtonClasses(): string {
  return "w-full justify-between";
}

function RailIconLabel({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-2">
      {icon}
      {label}
      {count != null && count > 1 ? (
        <span className="text-muted-foreground text-xs">({count})</span>
      ) : null}
    </span>
  );
}

function RailTraceButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  if (!artifact.traceViewerUrl) return <></>;
  return (
    <TraceViewerDialog artifact={artifact}>
      <RailIconLabel icon={<History />} label="Test Replay" />
      <ArrowRight className="opacity-50" aria-hidden />
    </TraceViewerDialog>
  );
}

function RailVideoButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" className={railButtonClasses()} />
        }
      >
        <RailIconLabel icon={<Play />} label="Video" />
        <ArrowRight className="opacity-50" aria-hidden />
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogTitle className="sr-only">Video: {artifact.name}</DialogTitle>
        <video
          className="w-full rounded-b-2xl bg-black"
          controls
          autoPlay
          src={artifact.downloadHref}
        >
          <track kind="captions" />
        </video>
      </DialogContent>
    </Dialog>
  );
}

function RailScreenshotButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" className={railButtonClasses()} />
        }
      >
        <RailIconLabel icon={<ImageIcon />} label="Screenshot" />
        <ArrowRight className="opacity-50" aria-hidden />
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogTitle className="sr-only">
          Screenshot: {artifact.name}
        </DialogTitle>
        <img
          className="w-full rounded-b-2xl bg-muted"
          alt={artifact.name}
          src={artifact.downloadHref}
        />
      </DialogContent>
    </Dialog>
  );
}

function TerminalBlock({ command }: { command: string }): React.ReactElement {
  const { copied, flash } = useCopiedFlag();

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      flash();
    } catch {
      // Silent — the label will just not flip to Copied. A toast could be
      // layered on later.
    }
  }
  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/60 bg-muted/30">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
          <Terminal size={12} />
          Terminal
        </span>
        <button
          type="button"
          onClick={() => {
            void onCopy();
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label={copied ? "Copied" : "Copy command"}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="px-3 py-2.5 font-mono text-xs text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
        {command}
      </pre>
    </div>
  );
}

function CopyArtifactButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  const { copied, flash } = useCopiedFlag();
  const [loading, setLoading] = useState(false);

  async function onCopy(): Promise<void> {
    setLoading(true);
    try {
      const res = await fetch(artifact.downloadHref);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      flash();
    } catch {
      // Silent — see TerminalBlock for rationale.
    } finally {
      setLoading(false);
    }
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className={railButtonClasses()}
      onClick={() => {
        void onCopy();
      }}
      loading={loading}
    >
      <RailIconLabel
        icon={copied ? <Check /> : <Copy />}
        label={copied ? "Copied" : "Copy prompt"}
      />
      <ArrowRight className="opacity-50" aria-hidden />
    </Button>
  );
}

/**
 * Monitor down / recovery alert email. Sent from
 * `src/lib/monitors/alerts.tsx` on a healthy↔down transition. `kind` selects
 * the down vs recovery copy; `url` deep-links to the monitor and `runUrl` (when
 * the execution produced a run) to the triggering run report.
 *
 * Incident fields are derived from execution history by the sender and degrade
 * gracefully — `MetaBox` drops any row whose value is absent:
 *   - down: `lastPassedAt` (when it was last green). The down alert is
 *     edge-triggered, so a "consecutive failures" count would always be 1 — the
 *     last-passed timestamp is the meaningful signal instead.
 *   - recovery: `recoveredAt`, `downtime`, `failedChecks` summarizing the
 *     just-ended outage, plus `lastDurationMs` of the recovering run.
 */
import { Link } from "react-email";
import {
  ButtonRow,
  CodeBox,
  FooterText,
  Heading1,
  Lead,
  LegalText,
  MetaBox,
  type MetaRowData,
  Pill,
  strong,
} from "./components";
import { EmailLayout, palette } from "./layout";

export interface MonitorAlertProps {
  kind: "down" | "recovery";
  monitorName: string;
  /** The terminal state that triggered the alert (e.g. fail/error/pass). */
  state: string;
  /** Failure detail for a down alert, when available. */
  errorMessage?: string | null;
  /** Deep link to the monitor detail page; omitted if the public URL is unset. */
  url?: string | null;
  /** Deep link to the triggering run report; omitted for non-browser runs. */
  runUrl?: string | null;
  /** Owning team's name → header "Monitors · {team}". */
  teamName?: string | null;
  /** Check cadence in seconds → "every 5 minutes". */
  intervalSeconds?: number | null;
  /** down: human time the monitor last passed (e.g. "Jun 15, 14:32 UTC"). */
  lastPassedAt?: string | null;
  /** recovery: human time it recovered. */
  recoveredAt?: string | null;
  /** recovery: total downtime, pre-formatted (e.g. "35m 12s"). */
  downtime?: string | null;
  /** recovery: number of checks that failed during the incident. */
  failedChecks?: number | null;
  /** recovery: duration of the recovering check, ms. */
  lastDurationMs?: number | null;
}

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `every ${h} hour${h === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `every ${m} minute${m === 1 ? "" : "s"}`;
  }
  return `every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const footerLink = { color: palette.fg3, textDecoration: "underline" } as const;

export function MonitorAlert({
  kind,
  monitorName,
  state,
  errorMessage,
  url,
  runUrl,
  teamName,
  intervalSeconds,
  lastPassedAt,
  recoveredAt,
  downtime,
  failedChecks,
  lastDurationMs,
}: MonitorAlertProps) {
  const down = kind === "down";
  const interval =
    intervalSeconds != null ? formatInterval(intervalSeconds) : null;
  const lastDuration =
    lastDurationMs != null ? formatDuration(lastDurationMs) : null;

  const rows: MetaRowData[] = down
    ? [
        { label: "Monitor", value: monitorName },
        { label: "Interval", value: interval },
        { label: "Last passed", value: lastPassedAt },
        {
          label: "Status",
          dot: "error",
          value: state === "error" ? "Errored" : "Failing",
        },
      ]
    : [
        { label: "Monitor", value: monitorName },
        { label: "Recovered at", value: recoveredAt },
        { label: "Downtime", value: downtime },
        {
          label: "Failed checks",
          value: failedChecks != null ? String(failedChecks) : undefined,
        },
        { label: "Last run", dot: "pass", value: lastDuration ?? undefined },
      ];

  const footer = (
    <FooterText>
      You’re receiving this because you subscribe to monitor alerts
      {teamName ? ` for ${teamName}` : ""}.{" "}
      {url ? (
        <Link href={url} style={footerLink}>
          Manage this monitor
        </Link>
      ) : (
        "Manage alerts from the monitor’s page."
      )}
    </FooterText>
  );

  return (
    <EmailLayout
      preview={
        down ? `${monitorName} is failing` : `${monitorName} is back to passing`
      }
      headerRight={teamName ? `Monitors · ${teamName}` : "Monitors"}
      footer={footer}
      legal={
        <LegalText>
          Wrightful — synthetic monitoring &amp; Playwright reporting
        </LegalText>
      }
    >
      <Pill tone={down ? "error" : "pass"}>
        {down ? "Monitor down" : "Recovered"}
      </Pill>
      <Heading1>
        {monitorName} {down ? "is failing" : "has recovered"}
      </Heading1>
      {down ? (
        <Lead>
          Wrightful ran <span style={strong}>{monitorName}</span> and the latest
          check {state === "error" ? "errored" : "failed"}.
          {lastPassedAt ? (
            <> It was last passing as of {lastPassedAt}.</>
          ) : null}
        </Lead>
      ) : (
        <Lead>
          The monitor is passing again
          {recoveredAt ? (
            <>
              {" "}
              as of <span style={strong}>{recoveredAt}</span>
            </>
          ) : null}
          .
          {downtime ? (
            <>
              {" "}
              Total downtime was <span style={strong}>{downtime}</span>
              {failedChecks != null
                ? ` across ${failedChecks} failed checks`
                : ""}
              .
            </>
          ) : null}
        </Lead>
      )}

      <MetaBox rows={rows} />

      {down && errorMessage ? (
        <CodeBox tone="error" label="Failure detail">
          {errorMessage}
        </CodeBox>
      ) : null}
      {!down ? (
        <CodeBox tone="pass" label="Passing">
          {`✓ ${monitorName} is responding again${
            lastDuration ? ` (${lastDuration})` : ""
          }`}
        </CodeBox>
      ) : null}

      {url ? (
        <ButtonRow
          primary={{ href: url, label: "View monitor" }}
          secondary={runUrl ? { href: runUrl, label: "View run" } : null}
        />
      ) : null}
    </EmailLayout>
  );
}

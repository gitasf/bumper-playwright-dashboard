import { StatusPill } from "@/components/status-pill";

/**
 * Monitor status vocabulary + visuals, ported from the design bundle
 * (`monitors-primitives.jsx`) onto our theme tokens. Presentational only (no
 * hooks) so it renders server-side and in client islands alike.
 *
 * State → token map: `pass`/`fail`/`degraded`/`error`/`running` are real theme
 * tokens; `queued`/`paused`/`never` resolve to neutral aliases (see
 * `styles.css`). Each state pairs a color token with a distinct GLYPH so Fail vs
 * Error etc. stay legible without relying on hue (colorblind-safe).
 */

export type MonitorStatusState =
  | "pass"
  | "degraded"
  | "fail"
  | "error"
  | "running"
  | "queued"
  | "paused"
  | "never";

type Glyph =
  | "check"
  | "diamond"
  | "cross"
  | "bang"
  | "spinner"
  | "ring"
  | "pause"
  | "dash";

interface StatusConfig {
  label: string;
  token: string;
  glyph: Glyph;
}

export const MON_STATUS: Record<MonitorStatusState, StatusConfig> = {
  pass: { label: "Pass", token: "pass", glyph: "check" },
  degraded: { label: "Degraded", token: "degraded", glyph: "diamond" },
  fail: { label: "Fail", token: "fail", glyph: "cross" },
  error: { label: "Error", token: "error", glyph: "bang" },
  running: { label: "Running", token: "running", glyph: "spinner" },
  queued: { label: "Queued", token: "queued", glyph: "ring" },
  paused: { label: "Paused", token: "paused", glyph: "pause" },
  never: { label: "Never run", token: "queued", glyph: "dash" },
};

function isMonitorStatusState(state: string): state is MonitorStatusState {
  return state in MON_STATUS;
}

function cfgFor(state: string): StatusConfig {
  return isMonitorStatusState(state) ? MON_STATUS[state] : MON_STATUS.queued;
}

/**
 * The status to render for a MONITOR (vs a single execution): a paused monitor
 * shows `paused`; an enabled one shows its last result, or `queued`/`never`
 * before its first run.
 */
export function monitorDisplayStatus(monitor: {
  enabled: number;
  lastStatus: string | null;
  lastRunAt: number | null;
}): MonitorStatusState {
  if (monitor.enabled !== 1) return "paused";
  if (monitor.lastStatus && isMonitorStatusState(monitor.lastStatus)) {
    return monitor.lastStatus;
  }
  return monitor.lastRunAt ? "queued" : "never";
}

/** A status glyph. Color comes from the state's token; shape encodes the state. */
export function MonGlyph({
  state,
  size = 14,
}: {
  state: string;
  size?: number;
}) {
  const cfg = cfgFor(state);
  const sw = Math.max(1.5, size / 8);
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  let inner: React.ReactNode = null;
  if (cfg.glyph === "spinner") {
    const r = (size - sw) / 2 - 0.5;
    const c = size / 2;
    return (
      <span
        aria-label="running"
        className="inline-flex animate-spin"
        style={{ width: size, height: size, color: `var(--${cfg.token})` }}
      >
        <svg
          fill="none"
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          width={size}
        >
          <circle
            cx={c}
            cy={c}
            opacity="0.25"
            r={r}
            stroke="currentColor"
            strokeWidth={sw}
          />
          <path
            d={`M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c + r} ${c}`}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={sw}
          />
        </svg>
      </span>
    );
  }

  switch (cfg.glyph) {
    case "check":
      inner = <path d="M3 8 L6.5 11.5 L13 4.5" />;
      break;
    case "cross":
      inner = (
        <g>
          <path d="M4 4 L12 12" />
          <path d="M12 4 L4 12" />
        </g>
      );
      break;
    case "diamond":
      inner = (
        <rect
          fill="currentColor"
          height="7.6"
          rx="1.4"
          stroke="none"
          transform="rotate(45 8 8)"
          width="7.6"
          x="4.2"
          y="4.2"
        />
      );
      break;
    case "bang":
      inner = (
        <g>
          <path d="M8 2.2 L14.4 13 L1.6 13 Z" />
          <path d="M8 6.4 V 9.2" />
          <circle cx="8" cy="11" fill="currentColor" r="0.5" stroke="none" />
        </g>
      );
      break;
    case "ring":
      inner = <circle cx="8" cy="8" r="4.4" strokeDasharray="2 2.2" />;
      break;
    case "pause":
      inner = (
        <g fill="currentColor" stroke="none">
          <rect height="8" rx="1" width="2.4" x="4.5" y="4" />
          <rect height="8" rx="1" width="2.4" x="9.1" y="4" />
        </g>
      );
      break;
    case "dash":
      inner = <path d="M4 8 H 12" />;
      break;
  }

  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ width: size, height: size, color: `var(--${cfg.token})` }}
      title={cfg.label}
    >
      <svg {...common} aria-label={cfg.label}>
        {inner}
      </svg>
    </span>
  );
}

/** Soft-tinted status pill: glyph + label, colored by the state's token. */
export function MonBadge({
  state,
  size = "md",
}: {
  state: string;
  size?: "sm" | "md";
}) {
  const cfg = cfgFor(state);
  return (
    <StatusPill
      cssVar={`--${cfg.token}`}
      icon={<MonGlyph size={size === "sm" ? 11 : 12} state={state} />}
      label={cfg.label}
      size={size}
    />
  );
}

/**
 * Mini history sparkline of recent execution states — one rounded bar per
 * execution, oldest→newest left→right, colored by state. Running executions are
 * skipped; renders a "no data" placeholder when empty.
 */
export function ExecStrip({
  executions,
  count = 24,
  width = 150,
  height = 22,
}: {
  executions: ReadonlyArray<{ state: string }>;
  count?: number;
  width?: number;
  height?: number;
}) {
  const items = executions
    .filter((e) => e.state !== "running")
    .slice(0, count)
    .reverse();
  if (items.length === 0) {
    return (
      <div
        className="flex items-center font-mono text-micro text-fg-4"
        style={{ width, height }}
      >
        no data
      </div>
    );
  }
  const cellW = width / count;
  return (
    <svg
      aria-hidden="true"
      height={height}
      style={{ display: "block" }}
      width={width}
    >
      {items.map((e, i) => {
        const cfg = cfgFor(e.state);
        const slot = count - items.length + i;
        return (
          <rect
            fill={`var(--${cfg.token})`}
            height={height - 4}
            key={i}
            rx="1.5"
            width={cellW - 1.5}
            x={slot * cellW + 0.5}
            y={2}
          />
        );
      })}
    </svg>
  );
}

/**
 * The monitor-TYPE glyph (vs the status glyph above): a beaker for `browser`
 * (a Playwright test), a globe for `http` (a URL uptime check), and a plug/socket
 * for `tcp`/`ping` (a raw port-connect check). Inline SVG on the same 16-grid
 * stroke set as {@link MonGlyph} so they read as a family. Used in the type pill
 * on the list + detail header.
 */
export function MonTypeGlyph({
  type,
  size = 10,
}: {
  type: string;
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (type === "http") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8 H 14" />
        <path d="M8 2 C 4.5 4.5, 4.5 11.5, 8 14 C 11.5 11.5, 11.5 4.5, 8 2 Z" />
      </svg>
    );
  }
  if (type === "tcp" || type === "ping") {
    // A plug/socket: two pins entering a connector body — reads as "a raw
    // connection to a port", distinct from the http globe.
    return (
      <svg {...common}>
        <path d="M6 2.5 V 5" />
        <path d="M10 2.5 V 5" />
        <rect height="4" rx="1" width="8" x="4" y="5" />
        <path d="M8 9 V 11" />
        <rect height="2.5" rx="0.8" width="5" x="5.5" y="11" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M6 2.5 V 7 L 3 13 H 13 L 10 7 V 2.5" />
      <path d="M5.5 2.5 H 10.5" />
    </svg>
  );
}

/** Count chip used in the list's status-summary strip. */
export function SummaryPill({
  state,
  count,
  label,
}: {
  state: MonitorStatusState;
  count: number;
  label: string;
}) {
  const cfg = cfgFor(state);
  return (
    <div className="flex items-center gap-[7px] rounded-md border border-line-1 bg-bg-1 py-1 pl-2 pr-2.5">
      <MonGlyph size={13} state={state} />
      <span
        className="font-mono text-sm font-semibold tabular-nums"
        style={{ color: count > 0 ? `var(--${cfg.token})` : "var(--fg-3)" }}
      >
        {count}
      </span>
      <span className="text-xs text-fg-3">{label}</span>
    </div>
  );
}

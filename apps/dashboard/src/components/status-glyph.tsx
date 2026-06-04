import type React from "react";
import { statusToken } from "@/lib/status";

interface StatusGlyphProps {
  status: string;
  size?: number;
}

/**
 * Glyph colour. `running` is a glyph-only state (not a Playwright outcome and
 * absent from the status registry), so it keeps its own token here; everything
 * else resolves through the shared registry's `statusToken`.
 */
function glyphToken(status: string): string {
  if (status === "running") return "var(--running)";
  return statusToken(status);
}

/**
 * Status indicator with shape-per-status — colorblind safety per the
 * Wrightful design bundle. Ports `StatusGlyph` from
 * `wrightful/project/primitives.jsx:63-112`.
 *
 * - passed:  check mark stroke
 * - failed:  X stroke
 * - flaky:   zigzag stroke
 * - skipped: three centered dots
 * - running: rotating quarter-arc spinner
 */
export function StatusGlyph({
  status,
  size = 14,
}: StatusGlyphProps): React.ReactElement {
  // Token resolves to a `var(...)` reference; SVG paint attributes can't take
  // `var()`, so we set it as the CSS `color` on the wrapping <span> and paint
  // with `currentColor`, which inherits the resolved value.
  const token = glyphToken(status);
  const color = "currentColor";
  const stroke = Math.max(1.4, size / 8);

  if (status === "running") {
    const r = (size - stroke) / 2 - 0.5;
    const cx = size / 2;
    const cy = size / 2;
    return (
      <span
        role="img"
        aria-label="running"
        className="inline-flex items-center justify-center"
        style={{ width: size, height: size, color: token }}
      >
        <svg
          aria-hidden="true"
          className="animate-spin"
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          width={size}
        >
          <circle
            cx={cx}
            cy={cy}
            fill="none"
            opacity="0.25"
            r={r}
            stroke={color}
            strokeWidth={stroke}
          />
          <path
            d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeWidth={stroke}
          />
        </svg>
      </span>
    );
  }

  let glyph: React.ReactNode = null;
  if (status === "passed") {
    glyph = (
      <path
        d="M3 8 L6.5 11.5 L13 4.5"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={stroke}
      />
    );
  } else if (status === "failed" || status === "timedout") {
    glyph = (
      <g stroke={color} strokeLinecap="round" strokeWidth={stroke}>
        <path d="M4 4 L12 12" />
        <path d="M12 4 L4 12" />
      </g>
    );
  } else if (status === "flaky" || status === "interrupted") {
    glyph = (
      <path
        d="M3 10.5 L6 6 L9 9.5 L13 4.5"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={stroke}
      />
    );
  } else if (status === "skipped") {
    glyph = (
      <g stroke={color} strokeLinecap="round" strokeWidth={stroke}>
        <circle cx="4.5" cy="8" fill={color} r="0.8" />
        <circle cx="8" cy="8" fill={color} r="0.8" />
        <circle cx="11.5" cy="8" fill={color} r="0.8" />
      </g>
    );
  } else {
    // Fallback: simple filled dot for unknown statuses.
    glyph = <circle cx="8" cy="8" fill={color} r="3" />;
  }

  return (
    <span
      role="img"
      aria-label={status}
      className="inline-flex items-center justify-center"
      style={{ width: size, height: size, color: token }}
    >
      <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
        {glyph}
      </svg>
    </span>
  );
}

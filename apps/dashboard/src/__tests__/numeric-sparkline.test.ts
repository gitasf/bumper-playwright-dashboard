import { describe, expect, it } from "vite-plus/test";
import {
  numericSparkline,
  type NumericSparklinePoint,
} from "@/components/analytics/metric-sparkline";

/**
 * `numericSparkline` is the pure projection extracted when the page-private
 * `DurationSparkline` was folded into `MetricSparkline`. It maps data-space
 * `{x, y}` points into the `width`×`height` pixel box and returns either SVG
 * path strings or a degenerate descriptor for 0/1 points. The invariants worth
 * pinning (and the ones the old hand-rolled copy got subtly different):
 *
 *  1. 0 points -> `{ kind: "empty" }`; 1 point -> a centred dot. These are the
 *     degenerate cases the duration-trend cell relied on.
 *  2. `x` is normalized by its REAL value, so sparse days render as
 *     proportional gaps — passing index-spacing here would be a silent
 *     regression for the slowest-tests trend.
 */

const W = 80;
const H = 20;
const PAD = 1.5;

function pts(...xy: [number, number][]): NumericSparklinePoint[] {
  return xy.map(([x, y]) => ({ x, y }));
}

describe("numericSparkline", () => {
  it("returns empty for no points", () => {
    expect(numericSparkline([], W, H, PAD)).toEqual({ kind: "empty" });
  });

  it("returns a centred dot for a single point", () => {
    expect(numericSparkline(pts([3, 7]), W, H, PAD)).toEqual({
      kind: "dot",
      cx: W / 2,
      cy: H / 2,
    });
  });

  it("projects endpoints to the padded box edges", () => {
    const geom = numericSparkline(pts([0, 0], [10, 10]), W, H, PAD);
    expect(geom.kind).toBe("line");
    if (geom.kind !== "line") return;
    // First x sits at the left pad, last x at width - pad.
    expect(geom.line.startsWith(`M${PAD},`)).toBe(true);
    expect(geom.line).toContain(`L${W - PAD},`);
    // Highest y maps to the top inset, lowest to the bottom inset.
    expect(geom.line).toContain(`,${PAD}`);
    expect(geom.line).toContain(`,${H - PAD}`);
  });

  it("spaces points by their real x value, not by index (sparse days = gaps)", () => {
    // x = 0, 1, 9 — the gap before the last point must dominate the width.
    const geom = numericSparkline(pts([0, 1], [1, 1], [9, 1]), W, H, PAD);
    expect(geom.kind).toBe("line");
    if (geom.kind !== "line") return;
    const xs = [...geom.line.matchAll(/[ML]([\d.]+),/g)].map((m) =>
      Number(m[1]),
    );
    const span = W - PAD * 2;
    expect(xs[0]).toBeCloseTo(PAD, 5);
    // x=1 is 1/9 of the way across; x=9 is at the far edge.
    expect(xs[1]).toBeCloseTo(PAD + (1 / 9) * span, 5);
    expect(xs[2]).toBeCloseTo(PAD + span, 5);
  });

  it("closes the area path back along the baseline", () => {
    const geom = numericSparkline(pts([0, 0], [10, 10]), W, H, PAD);
    if (geom.kind !== "line") return;
    // Area continues the line down to the baseline (y=H) and closes (Z).
    expect(geom.area.startsWith(geom.line)).toBe(true);
    expect(geom.area).toContain(`L${W - PAD},${H}`);
    expect(geom.area).toContain(`L${PAD},${H}`);
    expect(geom.area.trim().endsWith("Z")).toBe(true);
  });

  it("does not divide by zero when all y values are equal (flat series)", () => {
    const geom = numericSparkline(pts([0, 5], [5, 5], [10, 5]), W, H, PAD);
    expect(geom.kind).toBe("line");
    if (geom.kind !== "line") return;
    expect(geom.line).not.toContain("NaN");
    expect(geom.line).not.toContain("Infinity");
  });
});

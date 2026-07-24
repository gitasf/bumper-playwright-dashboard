import { describe, expect, it } from "vite-plus/test";
import { formatBytes, formatTraceOffset } from "@/trace-viewer/format";

describe("formatBytes", () => {
  it("formats zero as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("clamps negative byte counts to 0 B", () => {
    expect(formatBytes(-42)).toBe("0 B");
  });

  it("clamps NaN to 0 B", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("formats sub-1024 byte counts as whole bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats 1536 bytes as 1.5 KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("trims a trailing .0 for an exact 2 MB value", () => {
    expect(formatBytes(1024 * 1024 * 2)).toBe("2 MB");
  });

  it("caps unit growth at GB", () => {
    expect(formatBytes(1024 * 1024 * 1024 * 3.4)).toBe("3.4 GB");
  });
});

describe("formatTraceOffset", () => {
  it("formats a sub-second offset in ms", () => {
    expect(formatTraceOffset(1834, 1000)).toBe("+834ms");
  });

  it("rounds fractional millisecond offsets", () => {
    expect(formatTraceOffset(1000.6, 1000)).toBe("+1ms");
  });

  it("formats offsets past 1s in seconds", () => {
    expect(formatTraceOffset(2200, 1000)).toBe("+1.2s");
  });

  it("trims a trailing .0 in the seconds form", () => {
    expect(formatTraceOffset(3000, 1000)).toBe("+2s");
  });

  it("clamps a negative offset (ms before startTime) to +0ms", () => {
    expect(formatTraceOffset(500, 1000)).toBe("+0ms");
  });

  it("drops the + prefix when signed is false", () => {
    expect(formatTraceOffset(1834, 1000, { signed: false })).toBe("834ms");
    expect(formatTraceOffset(2200, 1000, { signed: false })).toBe("1.2s");
  });
});

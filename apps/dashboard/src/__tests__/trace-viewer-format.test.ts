import { describe, expect, it } from "vite-plus/test";
import {
  formatBytes,
  formatJsonRecordPreview,
  formatJsonValuePreview,
  formatPreviewText,
  formatTraceOffset,
  TEXT_PREVIEW_MAX_CHARS,
} from "@/trace-viewer/format";

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

describe("bounded trace previews", () => {
  it("caps a large request body before attempting JSON pretty-printing", () => {
    const preview = formatPreviewText(
      `{"payload":"${"x".repeat(TEXT_PREVIEW_MAX_CHARS * 2)}"}`,
      "application/json",
    );

    expect(preview.length).toBeLessThanOrEqual(
      TEXT_PREVIEW_MAX_CHARS + "… truncated".length,
    );
    expect(preview.endsWith("… truncated")).toBe(true);
  });

  it("bounds deeply nested action values and handles cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    value.payload = "x".repeat(TEXT_PREVIEW_MAX_CHARS * 2);

    const preview = formatJsonValuePreview(value);

    expect(preview).toContain("[Circular]");
    expect(preview.endsWith("… truncated")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(
      TEXT_PREVIEW_MAX_CHARS + "… truncated".length,
    );
  });

  it("bounds huge nested keys without merging shared-prefix collisions", () => {
    const prefix = "k".repeat(TEXT_PREVIEW_MAX_CHARS);
    const preview = formatJsonValuePreview({
      nested: {
        [`${prefix}-first`]: "first value",
        [`${prefix}-second`]: "second value",
      },
    });
    const parsed = JSON.parse(preview) as {
      nested: Record<string, string>;
    };
    const keys = Object.keys(parsed.nested);

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.length <= 256)).toBe(true);
    expect(keys[0]).toContain("… truncated");
    expect(keys[1]?.endsWith("[2]")).toBe(true);
    expect(Object.values(parsed.nested)).toEqual([
      "first value",
      "second value",
    ]);
    expect(preview.length).toBeLessThan(TEXT_PREVIEW_MAX_CHARS);
  });

  it("shares one count and formatting budget across all call parameters", () => {
    const manyValues = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [
        `param-${index}`,
        "x".repeat(2_000),
      ]),
    );

    const result = formatJsonRecordPreview(manyValues);
    const renderedChars = result.entries.reduce(
      (total, entry) => total + entry.label.length + entry.preview.length,
      0,
    );

    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(100);
    expect(renderedChars).toBeLessThanOrEqual(
      TEXT_PREVIEW_MAX_CHARS + "… truncated".length,
    );
  });

  it("keeps long call-parameter labels bounded and distinct", () => {
    const prefix = "p".repeat(TEXT_PREVIEW_MAX_CHARS);
    const result = formatJsonRecordPreview({
      [`${prefix}-first`]: "first value",
      [`${prefix}-second`]: "second value",
    });
    const labels = result.entries.map((entry) => entry.label);

    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(labels.every((label) => label.length <= 256)).toBe(true);
    expect(labels[0]).toContain("… truncated");
    expect(labels[1]?.endsWith("[2]")).toBe(true);
    expect(result.entries.map((entry) => entry.preview)).toEqual([
      '"first value"',
      '"second value"',
    ]);
  });
});

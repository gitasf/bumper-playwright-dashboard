import { describe, expect, it } from "vite-plus/test";
import { isSafeContentType, safeContentType } from "@/lib/content-types";

describe("isSafeContentType", () => {
  it("accepts known artifact types", () => {
    for (const ct of [
      "application/zip",
      "application/x-zip-compressed",
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/webm",
      "video/mp4",
      "text/plain",
      "application/json",
      "application/octet-stream",
      "application/pdf",
    ]) {
      expect(isSafeContentType(ct)).toBe(true);
    }
  });

  it("rejects HTML / script / SVG content types", () => {
    for (const ct of [
      "text/html",
      "text/html; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "application/javascript",
      "text/javascript",
      "application/ecmascript",
      "application/x-shockwave-flash",
    ]) {
      expect(isSafeContentType(ct)).toBe(false);
    }
  });

  it("normalises case and strips parameters", () => {
    expect(isSafeContentType("IMAGE/PNG")).toBe(true);
    expect(isSafeContentType("image/png; charset=utf-8")).toBe(true);
    expect(isSafeContentType("  application/zip  ")).toBe(true);
  });

  it("rejects empty / malformed input", () => {
    expect(isSafeContentType("")).toBe(false);
    expect(isSafeContentType("not-a-mime")).toBe(false);
  });
});

describe("safeContentType", () => {
  it("returns the normalised type when safe", () => {
    expect(safeContentType("image/png")).toBe("image/png");
    expect(safeContentType("IMAGE/PNG")).toBe("image/png");
    expect(safeContentType("text/plain; charset=utf-8")).toBe("text/plain");
  });

  it("falls back to octet-stream for unsafe input", () => {
    expect(safeContentType("text/html")).toBe("application/octet-stream");
    expect(safeContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeContentType("")).toBe("application/octet-stream");
    expect(safeContentType("garbage")).toBe("application/octet-stream");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { safeNextPath } from "@/lib/safe-next-path";

describe("safeNextPath", () => {
  it("allows plain absolute paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/t/acme/p/web")).toBe("/t/acme/p/web");
    expect(safeNextPath("/")).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("//evil.com/path")).toBe("/");
  });

  it("rejects backslash-smuggled URLs", () => {
    expect(safeNextPath("/\\evil.com")).toBe("/");
  });

  it("rejects absolute URLs", () => {
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("http://evil.com")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
  });

  it("rejects relative paths", () => {
    expect(safeNextPath("dashboard")).toBe("/");
    expect(safeNextPath("../admin")).toBe("/");
  });

  it("handles empty and undefined input", () => {
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });

  it("rejects paths with control characters", () => {
    expect(safeNextPath("/foo\r\nSet-Cookie: x=y")).toBe("/");
    expect(safeNextPath("/foo\nbar")).toBe("/");
    expect(safeNextPath("/foo\x00bar")).toBe("/");
    expect(safeNextPath("/foo\x7fbar")).toBe("/");
  });
});

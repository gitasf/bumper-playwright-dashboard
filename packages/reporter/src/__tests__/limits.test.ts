import { describe, it, expect, vi } from "vite-plus/test";
import { joinStdio, MAX_MESSAGE, truncate } from "../limits.js";

// `joinStdio` decodes + joins Playwright's per-attempt `TestResult.stdout` /
// `stderr` (an `Array<string | Buffer>`) into the single string the wire
// carries. These pin the three behaviours the ingest path relies on: mixed
// string/Buffer chunks decode + concatenate in order, "no output" collapses to
// null (the nullable column's contract), and a chatty run is clamped to the cap
// so it can't 413 the batch.
describe("joinStdio", () => {
  it("joins mixed string + Buffer chunks in emission order, decoding Buffers as UTF-8", () => {
    const out = joinStdio(
      ["line one\n", Buffer.from("line two\n", "utf8"), "line three\n"],
      MAX_MESSAGE,
    );
    expect(out).toBe("line one\nline two\nline three\n");
  });

  it("decodes multi-byte UTF-8 Buffer chunks without mojibake", () => {
    // A single emoji split is not attempted — whole-chunk decode is enough here;
    // this just proves toString('utf8') is used, not a lossy latin1 default.
    expect(joinStdio([Buffer.from("café ☕", "utf8")], MAX_MESSAGE)).toBe(
      "café ☕",
    );
  });

  it("decodes a multi-byte UTF-8 codepoint split across two Buffer chunks", () => {
    // "é" is 0xC3 0xA9 in UTF-8; split between the bytes so neither chunk holds
    // a complete codepoint — per-chunk `toString("utf8")` would yield mojibake.
    const full = Buffer.from("héllo", "utf8");
    const first = full.subarray(0, 2);
    const second = full.subarray(2);
    const out = joinStdio([first, second], MAX_MESSAGE);
    expect(out).toBe("héllo");
    expect(out).not.toContain("�");
  });

  it("joins a mixed string + split-Buffer array carrying decoder state across chunks", () => {
    const full = Buffer.from("héllo", "utf8");
    const out = joinStdio(
      ["pre:", full.subarray(0, 2), full.subarray(2), ":post"],
      MAX_MESSAGE,
    );
    expect(out).toBe("pre:héllo:post");
  });

  it("does not carry an incomplete Buffer byte past a later string chunk", () => {
    const out = joinStdio(
      [Buffer.from([0xc3]), "X", Buffer.from([0xa9])],
      MAX_MESSAGE,
    );
    expect(out).toBe("�X�");
  });

  it("returns null for a missing, empty, or all-empty-string array", () => {
    expect(joinStdio(undefined, MAX_MESSAGE)).toBeNull();
    expect(joinStdio(null, MAX_MESSAGE)).toBeNull();
    expect(joinStdio([], MAX_MESSAGE)).toBeNull();
    expect(joinStdio(["", ""], MAX_MESSAGE)).toBeNull();
  });

  it("truncates the joined output to the cap, byte-for-byte like truncate()", () => {
    const chunks = ["x".repeat(40_000), Buffer.from("y".repeat(40_000))];
    const out = joinStdio(chunks, MAX_MESSAGE);
    expect(out).toHaveLength(MAX_MESSAGE);
    // First half is the string chunk, so the kept prefix is all "x".
    expect(out).toBe(
      truncate("x".repeat(40_000) + "y".repeat(40_000), MAX_MESSAGE),
    );
  });

  it("does bounded work for one huge Buffer chunk", () => {
    const huge = Buffer.alloc(8 * 1024 * 1024, 0x78);
    const subarraySpy = vi.spyOn(huge, "subarray");
    const out = joinStdio([huge], MAX_MESSAGE);

    expect(out).toBe("x".repeat(MAX_MESSAGE));
    const furthestRead = Math.max(
      ...subarraySpy.mock.calls.map(([, end]) => end ?? 0),
    );
    expect(furthestRead).toBeLessThanOrEqual(MAX_MESSAGE);
  });

  it("does not re-encode an entire huge string before truncating", () => {
    const huge = "😀".repeat(4 * 1024 * 1024);
    expect(joinStdio([huge], MAX_MESSAGE)).toBe(truncate(huge, MAX_MESSAGE));
  });
});

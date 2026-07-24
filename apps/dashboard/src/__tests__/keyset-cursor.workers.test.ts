import { describe, expect, it } from "vite-plus/test";
import { decodeKeyset, encodeKeyset } from "@/lib/keyset-cursor";

/**
 * The shared keyset-cursor wire codec behind `decodeCursor` /
 * `decodeRankedCursor` (`run-results-page.ts`) and `decodeGroupCursor`
 * (`run-groups-page.ts`). These tests pin the ONE uniform malformed→null rule
 * the three hand-rolled decoders had drifted on — notably the empty leading
 * segment, which the group decoder used to accept (`":key"` silently decoded
 * to severity 0). Per-caller numeric coercion / final-segment rules are pinned
 * by the callers' own tests.
 */
describe("keyset-cursor codec", () => {
  it("round-trips segments through encode/decode", () => {
    expect(decodeKeyset(encodeKeyset(["1717000000000", "01HZX"]), 2)).toEqual([
      "1717000000000",
      "01HZX",
    ]);
    expect(decodeKeyset(encodeKeyset(["0", "42", "01HZX"]), 3)).toEqual([
      "0",
      "42",
      "01HZX",
    ]);
  });

  it("treats null / empty input as first-page", () => {
    expect(decodeKeyset(null, 2)).toBeNull();
    expect(decodeKeyset("", 2)).toBeNull();
  });

  it("degrades invalid base64 to null rather than throwing", () => {
    expect(decodeKeyset("not valid base64!!", 2)).toBeNull();
  });

  it("rejects a cursor missing a separator (too few segments)", () => {
    expect(decodeKeyset(btoa("1717000000000"), 2)).toBeNull();
    expect(decodeKeyset(btoa("1717000000000:01HZX"), 3)).toBeNull();
  });

  it("rejects an empty non-final segment (the drifted group-cursor guard)", () => {
    // Leading — the group decoder used to accept this, reading severity 0.
    expect(decodeKeyset(btoa(":01HZX"), 2)).toBeNull();
    // Middle — `Number("")` is 0, so this would otherwise decode silently.
    expect(decodeKeyset(btoa("0::01HZX"), 3)).toBeNull();
  });

  it("leaves final-segment emptiness to the caller (NULL-fallback group key)", () => {
    expect(decodeKeyset(btoa("4:"), 2)).toEqual(["4", ""]);
  });

  it("treats the final segment as 'the rest', preserving embedded colons", () => {
    expect(decodeKeyset(btoa("42:a:b:c"), 2)).toEqual(["42", "a:b:c"]);
    expect(decodeKeyset(btoa("0:42:a:b:c"), 3)).toEqual(["0", "42", "a:b:c"]);
  });
});

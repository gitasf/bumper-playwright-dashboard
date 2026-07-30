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

  it("round-trips segments above U+00FF instead of throwing", () => {
    // Group keys are raw file paths and project names, so a non-Latin-1 one is
    // ordinary user data. `btoa` on the joined string throws for these, which
    // used to 500 the page rather than return the next page of groups.
    for (const key of ["テスト.spec.ts", "Chrome 移动端", "e2e/café.spec.ts"]) {
      expect(decodeKeyset(encodeKeyset(["4", "value", key]), 3)).toEqual([
        "4",
        "value",
        key,
      ]);
    }
  });

  it("keeps decoding pure-ASCII cursors minted before the UTF-8 change", () => {
    // UTF-8 and Latin-1 agree on ASCII, so cursors already in flight when this
    // shipped must still decode — otherwise every open paginator resets.
    expect(decodeKeyset(btoa("4:value:e2e/login.spec.ts"), 3)).toEqual([
      "4",
      "value",
      "e2e/login.spec.ts",
    ]);
  });

  it("expires a pre-UTF-8 cursor over a Latin-1 key rather than mis-reading it", () => {
    // `btoa("4:value:café")` used to succeed, writing é as a bare 0xE9. That
    // byte is not valid UTF-8, so such a cursor now expires to first page. This
    // is the deliberate compatibility policy (see the codec's doc comment), not
    // an accident: the codec is unversioned, so an in-flight legacy cursor is
    // retired rather than guessed at.
    expect(decodeKeyset(btoa("4:value:café"), 3)).toBeNull();
  });

  it("degrades base64 that is not valid UTF-8 to null", () => {
    // A lone continuation byte. Without `fatal` this would decode to U+FFFD
    // mojibake and be compared against real group keys as if it were genuine.
    expect(decodeKeyset(btoa("4:value:\u0080"), 3)).toBeNull();
  });
});

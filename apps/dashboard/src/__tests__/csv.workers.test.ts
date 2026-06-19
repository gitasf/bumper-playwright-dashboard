import { describe, expect, it } from "vite-plus/test";
import { CSV_ROW_TERMINATOR, csvRow, escapeCsvField, toCsv } from "@/lib/csv";

/**
 * The CSV serializer (roadmap 2.5) is the export surface's load-bearing pure
 * function — a single escaping bug corrupts every exported spreadsheet (a stray
 * comma shifts columns; an unescaped quote desyncs the row; a literal newline
 * splits one record into two). These tests pin RFC-4180 behaviour exhaustively:
 * the metacharacters that force quoting, quote-doubling, the null/empty rule,
 * number-ish strings preserved verbatim, and CRLF framing.
 */

describe("escapeCsvField", () => {
  it("leaves a plain field bare (no quoting)", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("main")).toBe("main");
    expect(escapeCsvField("a-b_c.d")).toBe("a-b_c.d");
    expect(escapeCsvField("")).toBe("");
  });

  it("quotes and doubles embedded double-quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('"')).toBe('""""');
    // A bare quote anywhere triggers quoting of the whole field.
    expect(escapeCsvField('a"b')).toBe('"a""b"');
  });

  it("quotes fields containing the delimiter", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField(",")).toBe('","');
    expect(escapeCsvField("fix: handle commas, quotes")).toBe(
      '"fix: handle commas, quotes"',
    );
  });

  it("quotes fields containing CR, LF, or CRLF (would otherwise split records)", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(escapeCsvField("trailing\r")).toBe('"trailing\r"');
    // A multi-line commit message — the realistic case.
    expect(escapeCsvField("feat: x\n\nlong body")).toBe(
      '"feat: x\n\nlong body"',
    );
  });

  it("renders null and undefined as an empty (unquoted) field, not the word", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
    // Critically, NOT the literal string "null"/"undefined".
    expect(escapeCsvField(null)).not.toBe("null");
  });

  it("stringifies numbers and booleans", () => {
    expect(escapeCsvField(0)).toBe("0");
    expect(escapeCsvField(42)).toBe("42");
    expect(escapeCsvField(-1)).toBe("-1");
    expect(escapeCsvField(1.5)).toBe("1.5");
    expect(escapeCsvField(true)).toBe("true");
    expect(escapeCsvField(false)).toBe("false");
  });

  it("preserves number-ish / leading-zero STRINGS verbatim (no numeric coercion)", () => {
    // A commit SHA prefix or a leading-zero build id must round-trip as text.
    expect(escapeCsvField("007")).toBe("007");
    expect(escapeCsvField("0007abc")).toBe("0007abc");
    expect(escapeCsvField("00123")).toBe("00123");
    // A number-ish string containing a comma still gets quoted, not coerced.
    expect(escapeCsvField("1,000")).toBe('"1,000"');
  });

  it("does not quote fields with characters that are safe outside the framing set", () => {
    // Semicolons, tabs, pipes, single quotes are all RFC-4180-safe bare.
    expect(escapeCsvField("a;b")).toBe("a;b");
    expect(escapeCsvField("a\tb")).toBe("a\tb");
    expect(escapeCsvField("a|b")).toBe("a|b");
    expect(escapeCsvField("it's")).toBe("it's");
  });

  it("neutralizes spreadsheet formula injection in leading-metachar STRING fields", () => {
    // OWASP CSV injection: a cell starting with = + - @ (or a leading TAB) is
    // evaluated as a formula on import; prefix a single quote so it imports as
    // literal text (`=HYPERLINK`/`WEBSERVICE`/DDE can otherwise exfil or run).
    expect(escapeCsvField("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeCsvField("+1234567890")).toBe("'+1234567890");
    expect(escapeCsvField("-2+3")).toBe("'-2+3");
    expect(escapeCsvField("@cmd")).toBe("'@cmd");
    expect(escapeCsvField("\t=evil")).toBe("'\t=evil");
    // Composes with framing quoting when the field also needs quotes.
    expect(escapeCsvField("=a,b")).toBe('"\'=a,b"');
    // Guard is STRING-only: a typed negative number is NOT mangled to "'-1".
    expect(escapeCsvField(-1)).toBe("-1");
    // Only a LEADING metachar triggers the guard.
    expect(escapeCsvField("a=b")).toBe("a=b");
    expect(escapeCsvField("2-3")).toBe("2-3");
  });
});

describe("csvRow", () => {
  it("joins escaped cells with a comma and no terminator", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
    expect(csvRow(["a,b", "c"])).toBe('"a,b",c');
    expect(csvRow([1, "x", null, true])).toBe("1,x,,true");
  });

  it("emits an empty string for an empty row", () => {
    expect(csvRow([])).toBe("");
  });
});

describe("toCsv", () => {
  it("CRLF-terminates every row including the header and the last", () => {
    const out = toCsv(
      ["id", "name"],
      [
        ["1", "alpha"],
        ["2", "beta"],
      ],
    );
    expect(out).toBe("id,name\r\n1,alpha\r\n2,beta\r\n");
    expect(CSV_ROW_TERMINATOR).toBe("\r\n");
  });

  it("emits just the header row for an empty body", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });

  it("escapes cells inside the body", () => {
    const out = toCsv(
      ["msg"],
      [['has "quote"'], ["has,comma"], ["has\nnewline"]],
    );
    expect(out).toBe(
      'msg\r\n"has ""quote"""\r\n"has,comma"\r\n"has\nnewline"\r\n',
    );
  });

  it("accepts any iterable for the body (generator)", () => {
    function* gen() {
      yield ["a"];
      yield ["b"];
    }
    expect(toCsv(["c"], gen())).toBe("c\r\na\r\nb\r\n");
  });
});

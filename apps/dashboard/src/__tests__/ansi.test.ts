import { describe, expect, it } from "vite-plus/test";
import { ansiToHtml, stripAnsi } from "@/lib/ansi";

// `ansiToHtml` is the dashboard's only untrusted-text -> dangerouslySetInnerHTML
// seam: test-error-alert.tsx feeds attacker-controlled Playwright error text
// (errorMessage / errorStack, writable by anyone with a project API key via the
// ingest pipeline) straight into __html. Its XSS-safety rests on a two-part
// contract that otherwise lives only in a code comment:
//   (a) Anser.escapeForHtml runs FIRST so raw & < > are neutralised, and
//   (b) use_classes:true so Anser emits class="ansi-*" wrappers rather than
//       style="color:..." (a style attribute is an injection surface).
// These tests pin both halves so a refactor that reorders the calls, drops the
// escape, or flips use_classes fails loudly instead of silently reopening
// stored XSS on the dashboard origin.
describe("ansiToHtml (XSS contract)", () => {
  it("entity-escapes raw tags so no executable HTML survives", () => {
    const out = ansiToHtml("<script>alert(1)</script>");
    expect(out).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script");
  });

  it("neutralises an injected event-handler attribute", () => {
    const out = ansiToHtml('<img src=x onerror="alert(1)">');
    // The whole tag is escaped, so there is no live <img> element to fire
    // onerror — the literal `onerror=` text that remains is inert. What proves
    // safety is that the structural < > " are gone, not the substring text.
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("&lt;img");
    expect(out).not.toMatch(/[<>]/);
  });

  it('escapes the bare & < > " characters up front', () => {
    const out = ansiToHtml('a & b < c > d " e');
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).toContain("&quot;");
    // No raw structural characters remain to break out of the text context.
    expect(out).not.toMatch(/<[a-z/]/i);
  });

  it("leaves a javascript: payload inert as plain text", () => {
    const out = ansiToHtml("javascript:alert(1)");
    expect(out).toBe("javascript:alert(1)");
    // It is text, not an href/src — nothing makes it navigable.
    expect(out).not.toMatch(/href=|src=/i);
  });

  it("colourises SGR sequences with class= wrappers, never style= or on*=", () => {
    const out = ansiToHtml("\x1b[31mRED\x1b[0m");
    expect(out).toContain('class="ansi-red-fg"');
    expect(out).toContain("RED");
    // The load-bearing half of the contract: classes, not inline styles or
    // event handlers, so the attribute surface stays unexploitable.
    expect(out).not.toMatch(/style=|on\w+=/);
  });

  it("renders ESC-stripped SGR residue as literal text without interpreting it", () => {
    // When the ESC byte is dropped before the string reaches us, `[31m` arrives
    // as literal text. It must round-trip untouched (not colourised, not a sink).
    const out = ansiToHtml("[31mRED[0m");
    expect(out).toBe("[31mRED[0m");
    expect(out).not.toMatch(/<span/);
  });
});

// stripAnsi is a noise-stripper, NOT part of the XSS contract: its output goes
// to a React `title=` attribute and a text node, both auto-escaped by React.
// These cases just lock the SGR-removal behaviour for both escape forms.
describe("stripAnsi (noise stripper)", () => {
  it("removes the real \\x1b[..m escape sequence", () => {
    expect(stripAnsi("\x1b[31mRED\x1b[0m")).toBe("RED");
  });

  it("removes the ESC-stripped [..m residue form", () => {
    expect(stripAnsi("[31mRED[0m")).toBe("RED");
  });

  it("leaves non-SGR text untouched", () => {
    expect(stripAnsi("plain error message")).toBe("plain error message");
  });
});

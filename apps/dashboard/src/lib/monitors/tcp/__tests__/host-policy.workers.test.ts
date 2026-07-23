import { describe, expect, it } from "vite-plus/test";
import { checkTcpHostPolicy } from "@/lib/monitors/tcp/host-policy";

/**
 * `checkTcpHostPolicy` is the pure write/read-path SSRF guard for tcp/ping
 * monitor hosts — the raw-socket twin of `checkUrlPolicy`. It reuses the http
 * policy's `isBlockedHostname` block set (so the two block the EXACT same hosts)
 * and adds bare-host shape validation. These pin each rejection reason and that
 * legitimate public hosts pass.
 */

function ok(host: string) {
  return checkTcpHostPolicy(host).ok;
}

describe("checkTcpHostPolicy — allowed", () => {
  it("accepts public DNS names and public IPv4 literals", () => {
    expect(ok("db.example.com")).toBe(true);
    expect(ok("example.com")).toBe(true);
    expect(ok("8.8.8.8")).toBe(true);
    expect(ok("172.15.0.1")).toBe(true);
    expect(ok("172.32.0.1")).toBe(true);
  });
});

describe("checkTcpHostPolicy — rejected (SSRF block set, shared with http)", () => {
  it("rejects localhost and *.localhost", () => {
    expect(ok("localhost")).toBe(false);
    expect(ok("api.localhost")).toBe(false);
  });

  it("rejects loopback / private / link-local / metadata / unspecified IPv4", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
    ]) {
      const r = checkTcpHostPolicy(host);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/private, loopback/i);
    }
  });

  it("rejects IPv6 loopback / unique-local / link-local literals (bare or bracketed)", () => {
    expect(ok("[::1]")).toBe(false);
    expect(ok("[fc00::1]")).toBe(false);
    expect(ok("[fd12:3456::1]")).toBe(false);
    expect(ok("[fe80::1]")).toBe(false);
    expect(ok("[fe8f::1]")).toBe(false);
    expect(ok("[febf::1]")).toBe(false);
    // BARE (unbracketed) form — a tcp host is never wrapped in `new URL()`, so
    // unlike the http policy it sees the raw literal a user typed directly.
    // Regression for the bug where a bare IPv6 literal fell through to the
    // IPv4 parser and was silently allowed.
    expect(ok("::1")).toBe(false);
    expect(ok("fe80::1")).toBe(false);
    expect(ok("fc00::1")).toBe(false);
  });

  it("accepts a public bare IPv6 literal (no over-blocking)", () => {
    expect(ok("2606:4700:4700::1111")).toBe(true);
  });
});

describe("checkTcpHostPolicy — bare-host shape", () => {
  it("rejects an empty host", () => {
    const r = checkTcpHostPolicy("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/enter a host/i);
  });

  it("rejects a URL / a host carrying a scheme, path, or credentials", () => {
    for (const h of [
      "https://example.com",
      "example.com/health",
      "user@example.com",
      "example.com:5432/path",
      "has space",
    ]) {
      const r = checkTcpHostPolicy(h);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/bare host/i);
    }
  });

  it("rejects an over-long host", () => {
    expect(ok("a".repeat(300))).toBe(false);
  });

  it("rejects non-canonical IPv4 encodings (SSRF block-list bypass)", () => {
    // Short/decimal/octal forms that resolve to loopback or other internal IPs
    // but dodge the canonical-dotted-quad block set.
    for (const h of [
      "127.1", // short form of 127.0.0.1
      "2130706433", // decimal form of 127.0.0.1
      "0177.0.0.1", // octal-ish first octet
      "10.0", // short private form
      "1.2.3.4.5", // too many octets
    ]) {
      expect(ok(h)).toBe(false);
    }
    // A canonical public dotted-quad still passes (regression guard).
    expect(ok("8.8.8.8")).toBe(true);
  });
});

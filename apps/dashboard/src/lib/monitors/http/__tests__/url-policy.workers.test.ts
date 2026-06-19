import { describe, expect, it } from "vite-plus/test";
import { checkUrlPolicy } from "@/lib/monitors/http/url-policy";

/**
 * `checkUrlPolicy` is the pure write/read-path guard for http monitor URLs:
 * scheme allowlist, no credentials, length caps, and the SSRF defense rejecting
 * literal private / loopback / link-local / metadata hosts. These pin each
 * rejection reason and that legitimate public URLs (including one's own
 * dashboard) pass.
 */

function ok(url: string) {
  return checkUrlPolicy(url).ok;
}

describe("checkUrlPolicy — allowed", () => {
  it("accepts public http + https URLs", () => {
    expect(ok("https://example.com")).toBe(true);
    expect(ok("http://example.com/health?x=1")).toBe(true);
    expect(ok("https://dash.wrightful.app/t/acme/p/web")).toBe(true);
  });

  it("accepts a public IPv4 literal", () => {
    expect(ok("https://8.8.8.8")).toBe(true);
  });

  it("accepts IPs just outside the private 172.16/12 range", () => {
    expect(ok("https://172.15.0.1")).toBe(true);
    expect(ok("https://172.32.0.1")).toBe(true);
  });
});

describe("checkUrlPolicy — rejected", () => {
  it("rejects non-http(s) schemes", () => {
    for (const u of [
      "ftp://example.com",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "ws://example.com",
    ]) {
      const r = checkUrlPolicy(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/http/i);
    }
  });

  it("rejects credentials in the URL", () => {
    const r = checkUrlPolicy("https://user:pass@example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/username or password/i);
  });

  it("rejects localhost and *.localhost", () => {
    expect(ok("http://localhost")).toBe(false);
    expect(ok("http://localhost:3000/health")).toBe(false);
    expect(ok("http://api.localhost")).toBe(false);
  });

  it("rejects loopback / private / link-local / unspecified IPv4", () => {
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
      expect(ok(`http://${host}`)).toBe(false);
    }
  });

  it("rejects IPv6 loopback / unique-local / link-local literals", () => {
    expect(ok("http://[::1]")).toBe(false);
    expect(ok("http://[fc00::1]")).toBe(false);
    expect(ok("http://[fd12:3456::1]")).toBe(false);
    expect(ok("http://[fe80::1]")).toBe(false);
    // fe80::/10 spans the whole second byte 0x80–0xbf, not just fe80 — the
    // fe81::–fe8f:: span must be rejected too (regression for the `fe80` prefix).
    expect(ok("http://[fe81::1]")).toBe(false);
    expect(ok("http://[fe8f::1]")).toBe(false);
    expect(ok("http://[feaa::1]")).toBe(false);
    expect(ok("http://[febf::1]")).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(ok("not a url")).toBe(false);
    expect(ok("://missing-scheme")).toBe(false);
  });

  it("rejects an over-long URL", () => {
    expect(ok(`https://example.com/${"a".repeat(2100)}`)).toBe(false);
  });
});

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

  it("accepts public IPv6 + a PUBLIC IPv4-mapped IPv6 (no over-blocking)", () => {
    expect(ok("https://[2606:4700:4700::1111]")).toBe(true);
    expect(ok("https://[::ffff:8.8.8.8]")).toBe(true);
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
    // A trailing root dot is preserved by `new URL()` on DNS names and must
    // not dodge the localhost check.
    expect(ok("http://localhost./health")).toBe(false);
    expect(ok("http://api.localhost.")).toBe(false);
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

  it("rejects IPv4-mapped / -compatible / NAT64 IPv6 that embed a blocked v4", () => {
    // Regression: `new URL()` normalizes the dotted IPv4 tail to HEX
    // (`[::ffff:127.0.0.1]` -> `[::ffff:7f00:1]`), so the old "tail contains a
    // dot" heuristic let loopback + cloud-metadata through. All of these reach
    // 127.0.0.1 / 169.254.169.254 / 10.0.0.1 and must be rejected.
    for (const host of [
      "[::ffff:127.0.0.1]", // IPv4-mapped loopback (dotted input)
      "[::ffff:7f00:1]", // ...same, hex form
      "[::ffff:169.254.169.254]", // IPv4-mapped cloud metadata
      "[::ffff:a9fe:a9fe]", // ...same, hex form
      "[0:0:0:0:0:ffff:127.0.0.1]", // uncompressed IPv4-mapped loopback
      "[::ffff:10.0.0.1]", // IPv4-mapped RFC1918
      "[::127.0.0.1]", // deprecated IPv4-compatible loopback
      "[64:ff9b::a9fe:a9fe]", // NAT64 well-known prefix -> 169.254.169.254
      "[64:ff9b::7f00:1]", // NAT64 -> 127.0.0.1
    ]) {
      expect(ok(`http://${host}`)).toBe(false);
    }
  });

  it("rejects an unparseable URL", () => {
    expect(ok("not a url")).toBe(false);
    expect(ok("://missing-scheme")).toBe(false);
  });

  it("rejects an over-long URL", () => {
    expect(ok(`https://example.com/${"a".repeat(2100)}`)).toBe(false);
  });
});

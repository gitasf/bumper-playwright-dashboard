/**
 * URL policy for `http` (uptime) monitors — PURE (no `void/*` imports) so it is
 * unit-tested directly and reused across both validation points:
 *   - **write/config path** — the `HttpMonitorConfigSchema` URL refinement (and,
 *     since the executor parses the stored config through that same schema, the
 *     entered URL is re-vetted every run, not just at save time);
 *   - **read path** — `runHttpCheck` re-checks the FINAL url after a followed
 *     redirect (defense in depth: a redirect can land on a host the config-time
 *     check never saw).
 *
 * What it enforces, and WHY each rule earns its place:
 *   - **scheme allowlist** (`http:` / `https:`) — a check is an outbound web
 *     request; `file:`/`data:`/`blob:` etc. are never a monitoring target.
 *   - **no credentials in the URL** — `https://user:pass@host` would leak a
 *     secret into a stored monitor row + every result; force header-based auth
 *     later instead.
 *   - **reject literal private / loopback / link-local / metadata hosts** — this
 *     is the SSRF guard. Cloudflare Workers egress already can't reach these
 *     (so it is mostly fail-fast UX + defense in depth), but rejecting them at
 *     the boundary keeps a confusing "it just times out" experience from ever
 *     reaching a user, and hard-codes the intent so a future non-Workers runner
 *     inherits the guard. Monitoring one's OWN public dashboard URL is fine and
 *     allowed — handling a check never triggers another check, so there is no
 *     recursion to guard against.
 *   - **length caps** — bound the stored row + a pathological host.
 */

/** The verdict: `ok`, or a user-facing `reason` the form surfaces inline. */
export type UrlPolicyResult = { ok: true } | { ok: false; reason: string };

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_URL_LENGTH = 2048;
const MAX_HOST_LENGTH = 255;

/**
 * Parse an IPv4 dotted-quad to its four octets, or `null` if `host` is not a
 * bare IPv4 literal (a DNS name like `example.com` returns `null` and is
 * allowed — we only block literal IPs, since a name resolving into a private
 * range is caught by the runtime's own egress rules, not statically here).
 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * True when four IPv4 octets fall in a private / loopback / link-local /
 * metadata / multicast range. Shared by the bare-IPv4 path AND the IPv4-in-IPv6
 * (mapped / compatible / NAT64) path so an embedded address is classified
 * identically however it is spelled.
 */
function isBlockedIpv4Octets(octets: number[]): boolean {
  const a = octets[0]!;
  const b = octets[1]!;
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local + metadata 169.254.0.0/16
  if (a >= 224) return true; // multicast / reserved 224.0.0.0+
  return false;
}

/** True when an IPv4 literal falls in a private / loopback / link-local range. */
function isBlockedIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  return isBlockedIpv4Octets(octets);
}

/**
 * Parse an IPv6 literal (brackets already stripped, lowercased) into its 16
 * bytes, or `null` if it is not a valid IPv6 literal. Handles `::` zero-
 * compression and a trailing embedded dotted-IPv4 group (`::ffff:1.2.3.4`).
 *
 * A coarse textual prefix check is NOT enough: the WHATWG `URL` parser
 * normalizes an IPv4-mapped literal like `[::ffff:127.0.0.1]` to a HEX tail
 * (`[::ffff:7f00:1]`), so a "does the last group contain a dot" heuristic
 * silently lets loopback / metadata addresses through. Parsing to bytes lets us
 * classify the mapped / compatible / NAT64 forms by their real embedded IPv4.
 */
function parseIpv6(input: string): number[] | null {
  let text = input;

  // Rewrite a trailing embedded dotted-IPv4 group (the final 32 bits) to its
  // two hextets so the remainder parses uniformly: `::ffff:1.2.3.4` becomes
  // `::ffff:102:304`.
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = text.slice(0, dotted.index!) + `${hi}:${lo}`;
  }

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const bytes: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const n = Number.parseInt(group, 16);
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
  };

  const halves = text.split("::");
  if (halves.length > 2) return null; // at most one `::`
  const head = parseGroups(halves[0]!);
  if (!head) return null;
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!tail) return null;

  const explicit = head.length + tail.length;
  if (halves.length === 2) {
    const pad = 16 - explicit; // `::` expands to the zero bytes between head/tail
    if (pad < 0) return null;
    return [...head, ...new Array<number>(pad).fill(0), ...tail];
  }
  if (explicit !== 16) return null;
  return head;
}

/** True when 16 IPv6 bytes are loopback / unspecified / link-local / unique-
 * local, or embed a blocked IPv4 (mapped `::ffff:0:0/96`, compatible, or NAT64
 * `64:ff9b::/96`). */
function isBlockedIpv6Bytes(b: number[]): boolean {
  const allZero = (lo: number, hi: number) =>
    b.slice(lo, hi).every((x) => x === 0);
  if (allZero(0, 16)) return true; // :: unspecified
  if (allZero(0, 15) && b[15] === 1) return true; // ::1 loopback
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  // IPv4-mapped ::ffff:0:0/96 — classify by the embedded IPv4.
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4Octets(b.slice(12));
  }
  // NAT64 well-known prefix 64:ff9b::/96 — embeds an IPv4 in the low 32 bits.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    allZero(4, 12)
  ) {
    return isBlockedIpv4Octets(b.slice(12));
  }
  // IPv4-compatible ::0.0.0.0/96 (deprecated) — classify by the embedded IPv4.
  if (allZero(0, 12)) return isBlockedIpv4Octets(b.slice(12));
  return false;
}

/** Coarse textual prefix guard — a backstop for anything `parseIpv6` can't
 * parse (the WHATWG parser should have rejected such hosts upstream), so we
 * never regress to allowing an obvious literal. */
function isBlockedIpv6Prefix(h: string): boolean {
  if (h === "::1" || h === "::") return true;
  if (
    h.startsWith("fe8") ||
    h.startsWith("fe9") ||
    h.startsWith("fea") ||
    h.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  const tail = h.split(":").pop() ?? "";
  if (tail.includes(".")) return isBlockedIpv4(tail);
  return false;
}

/**
 * True when an IPv6 literal (brackets already stripped) is loopback / unique-
 * local / link-local / unspecified, or embeds a blocked IPv4 in any of the
 * mapped / compatible / NAT64 forms.
 */
function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase();
  const bytes = parseIpv6(h);
  return bytes ? isBlockedIpv6Bytes(bytes) : isBlockedIpv6Prefix(h);
}

/**
 * True when the host is one we never allow a monitor to target — the SSRF block
 * set: `localhost` (and `*.localhost`), and literal private / loopback /
 * link-local / metadata IPv4 + IPv6 addresses. EXPORTED because it is the
 * genuinely shared kernel of the monitor SSRF guard: `tcp/host-policy.ts` reuses
 * it for the raw-socket check so the http and tcp policies block the EXACT same
 * host set (one place to add a newly-discovered internal range). Accepts either
 * a bare hostname or a bracketed IPv6 literal (`[::1]`).
 */
export function isBlockedHostname(hostname: string): boolean {
  let host = hostname.toLowerCase();
  // WHATWG `URL.hostname` preserves a trailing dot on a DNS name
  // (`localhost.` stays `localhost.`), which would dodge the exact-string
  // checks below. The root dot is semantically a no-op, so strip it. (IPv4
  // literals are already normalized dot-free by the parser, and an IPv6
  // literal ends in `]`, so this only touches DNS names.)
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // WHATWG `URL.hostname` keeps IPv6 in brackets — strip them before matching.
  if (host.startsWith("[") && host.endsWith("]")) {
    return isBlockedIpv6(host.slice(1, -1));
  }
  return isBlockedIpv4(host);
}

/**
 * Validate a monitor target URL against the policy. Returns `{ ok: true }` or a
 * single user-facing `reason`. Pure and synchronous — the same call serves the
 * zod refinement (write path) and the executor's pre-fetch re-check (read path).
 */
export function checkUrlPolicy(raw: string): UrlPolicyResult {
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "URL is too long" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Enter a valid URL" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "URLs may not contain a username or password" };
  }
  const host = url.hostname;
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return { ok: false, reason: "URL host is invalid" };
  }
  if (isBlockedHostname(host)) {
    return {
      ok: false,
      reason: "Private, loopback, and link-local addresses can't be monitored",
    };
  }
  return { ok: true };
}

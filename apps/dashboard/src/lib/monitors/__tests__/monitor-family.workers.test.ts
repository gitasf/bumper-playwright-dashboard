import { describe, expect, it } from "vite-plus/test";
import { monitorFamily, type MonitorType } from "@/lib/monitors/types";

/**
 * `monitorFamily` is the ONE definition of the uptime-vs-browser partition that
 * both the sweep's queue routing (`crons/sweep-monitors.ts` — `queues.uptime`
 * vs `queues.monitors`) and the consumers' executor dispatch
 * (`executor-registry.ts`) fork on. Pinned here so a new monitor type must
 * consciously pick a family — and so both call sites move together when it
 * does. (The registry itself can't be imported under vitest — it pulls in
 * `cloudflare:sockets` / `void/sandbox` — which is why the partition, not the
 * dispatch, is what gets the unit test.)
 */
describe("monitorFamily", () => {
  it("puts http + tcp + ping in the uptime family (batched queue, no container)", () => {
    expect(monitorFamily("http")).toBe("uptime");
    expect(monitorFamily("tcp")).toBe("uptime");
    expect(monitorFamily("ping")).toBe("uptime");
  });

  it("puts browser in the browser family (container-backed queue)", () => {
    expect(monitorFamily("browser")).toBe("browser");
  });

  it("falls back to browser for an unknown type (both call sites' historical default)", () => {
    expect(monitorFamily("carrier-pigeon")).toBe("browser");
    expect(monitorFamily("")).toBe("browser");
  });

  it("covers every declared MonitorType (a new type must pick a family here)", () => {
    const all: Record<MonitorType, "uptime" | "browser"> = {
      http: "uptime",
      tcp: "uptime",
      ping: "uptime",
      browser: "browser",
    };
    for (const [type, family] of Object.entries(all)) {
      expect(monitorFamily(type)).toBe(family);
    }
  });
});

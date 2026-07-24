import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const config = vi.hoisted(() => ({
  VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: undefined as string | undefined,
}));
vi.mock("void/env", () => ({ env: config }));
import { bridgeIframeSrc, BRIDGE_PATH } from "@/trace-viewer/bridge-iframe";
import {
  sha1DownloadUrl,
  snapshotIframeUrl,
  snapshotPopoutUrl,
} from "@/trace-viewer/model";
import type { Snapshot } from "@/trace-viewer/model";
import {
  isSeparateTraceViewerOrigin,
  isTraceViewerHost,
  snapshotSandbox,
  traceViewerBridgeOrigin,
  traceViewerOrigin,
  traceViewerScopeUrl,
} from "@/trace-viewer/origin";

const SEPARATE = "https://traces.example.com";

const snap = {
  snapshotName: "n@1",
  pageId: "page@1",
} as unknown as Snapshot;

afterEach(() => {
  config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = undefined;
});

describe("trace-viewer origin — same-origin default", () => {
  it("resolves to empty origin / relative scope", () => {
    expect(traceViewerOrigin()).toBe("");
    expect(isSeparateTraceViewerOrigin("https://dash.example")).toBe(false);
    expect(traceViewerScopeUrl()).toBe("/trace-viewer/");
    // Unconfigured, NO host is "the viewer host" — every origin keeps the
    // strict snapshot CSP.
    expect(isTraceViewerHost("https://dash.example")).toBe(false);
  });

  it("keeps the bridge origin equal to the hosting page origin", () => {
    expect(traceViewerBridgeOrigin("https://dash.example")).toBe(
      "https://dash.example",
    );
  });

  it("forbids snapshot scripts (allow-same-origin only)", () => {
    expect(snapshotSandbox("https://dash.example")).toBe("allow-same-origin");
  });

  it("builds relative snapshot / popout / sha1 URLs", () => {
    expect(snapshotIframeUrl("trace.zip", snap)).toMatch(
      /^\/trace-viewer\/snapshot\/page@1\?/,
    );
    expect(snapshotPopoutUrl("trace.zip", "https://dash.example/x")).toMatch(
      /^\/trace-viewer\/snapshot\.html\?/,
    );
    expect(sha1DownloadUrl("trace.zip", "abc", "s.png", "image/png")).toMatch(
      /^\/trace-viewer\/sha1\/abc\?/,
    );
    expect(BRIDGE_PATH).toBe("/trace-viewer/bridge.html");
  });
});

describe("trace-viewer origin — separate cookieless origin", () => {
  it("strips a trailing slash and reports a separate origin", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = `${SEPARATE}/path/`;
    expect(traceViewerOrigin()).toBe(SEPARATE);
    expect(isSeparateTraceViewerOrigin("https://dash.example")).toBe(true);
    expect(traceViewerScopeUrl()).toBe(`${SEPARATE}/trace-viewer/`);
  });

  it("targets the configured origin for the bridge, never the page", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = SEPARATE;
    expect(traceViewerBridgeOrigin("https://dash.example")).toBe(SEPARATE);
  });

  it("identifies ONLY the configured host as the viewer host (server-side CSP gate)", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = `${SEPARATE}/path/`;
    expect(isTraceViewerHost(SEPARATE)).toBe(true);
    // The dashboard origin is never the viewer host — it must keep the
    // script-less snapshot CSP even in separate-origin mode.
    expect(isTraceViewerHost("https://dash.example")).toBe(false);
    expect(isTraceViewerHost("")).toBe(false);
    expect(isTraceViewerHost("not-a-url")).toBe(false);
  });

  it("re-enables snapshot scripts safely (cross-origin to the session)", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = SEPARATE;
    expect(snapshotSandbox("https://dash.example")).toBe(
      "allow-same-origin allow-scripts",
    );
  });

  it("builds absolute snapshot / sha1 URLs at the configured origin", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = SEPARATE;
    const iframe = new URL(snapshotIframeUrl("trace.zip", snap));
    expect(iframe.origin).toBe(SEPARATE);
    expect(iframe.pathname).toBe("/trace-viewer/snapshot/page@1");
    const sha1 = new URL(
      sha1DownloadUrl("trace.zip", "abc", "s.png", "image/png"),
    );
    expect(sha1.origin).toBe(SEPARATE);
  });

  it("fails closed for a same-origin or malformed configuration", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN =
      "https://dash.example/trace-host";
    expect(traceViewerOrigin()).toBe("https://dash.example");
    expect(isSeparateTraceViewerOrigin("https://dash.example")).toBe(false);
    expect(snapshotSandbox("https://dash.example")).toBe("allow-same-origin");
    expect(traceViewerBridgeOrigin("https://dash.example/path")).toBe(
      "https://dash.example",
    );

    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = "not a url";
    expect(traceViewerOrigin()).toBe("");
    expect(isSeparateTraceViewerOrigin("https://dash.example")).toBe(false);
    expect(snapshotSandbox("https://dash.example")).toBe("allow-same-origin");
  });

  it("fails closed when the hosting page origin is unavailable", () => {
    config.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN = SEPARATE;
    expect(isSeparateTraceViewerOrigin("")).toBe(false);
    expect(snapshotSandbox("")).toBe("allow-same-origin");
    expect(traceViewerBridgeOrigin("")).toBe("");
  });
});

describe("bridgeIframeSrc — explicit parent-origin handshake", () => {
  it("carries the hosting origin as `host` and the trace param", () => {
    const src = bridgeIframeSrc("trace.zip");
    const url = new URL(src, "https://dash.example");
    expect(url.pathname).toBe("/trace-viewer/bridge.html");
    expect(url.searchParams.get("trace")).toBe("trace.zip");
    expect(url.searchParams.get("host")).toBe(window.location.origin);
  });

  it("omits the trace param in warm (register-only) mode", () => {
    const url = new URL(bridgeIframeSrc(undefined), "https://dash.example");
    expect(url.searchParams.has("trace")).toBe(false);
  });
});

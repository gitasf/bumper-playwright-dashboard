"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mountBridgeIframe } from "./bridge-iframe";
import { traceViewerBridgeOrigin } from "./origin";
import type { ContextEntry } from "./vendor/entries";

const BRIDGE_STARTUP_TIMEOUT_MS = 30_000;
const TRACE_LOAD_SILENCE_TIMEOUT_MS = 60_000;
const BRIDGE_FETCH_TIMEOUT_MS = 20_000;

type Progress = { done: number; total: number };

export type TraceModelState =
  | { status: "loading"; progress: Progress | null }
  | { status: "error"; error: string }
  | {
      status: "ready";
      traceUrl: string;
      contextEntries: ContextEntry[];
      switching: { progress: Progress | null } | null;
    };

export type TraceBridge = {
  fetchJson: (path: string) => Promise<unknown>;
  fetchBlob: (path: string) => Promise<Blob>;
  readonly traceUrl: string;
};

type BridgeMessage =
  | { method: "progress"; params: Progress }
  | { method: "ready"; params: Record<string, never> }
  | { method: "model"; params: { contextEntries: ContextEntry[] } }
  | { method: "error"; params: { error: string } }
  | { method: "warm"; params: Record<string, never> }
  | {
      method: "fetchResult";
      params: {
        id: number;
        ok: boolean;
        status: number;
        body?: unknown;
        error?: string;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProgress(value: unknown): value is Progress {
  return (
    isRecord(value) &&
    typeof value.done === "number" &&
    Number.isFinite(value.done) &&
    typeof value.total === "number" &&
    Number.isFinite(value.total)
  );
}

export function isBridgeMessage(data: unknown): data is BridgeMessage {
  if (!isRecord(data) || data.source !== "wrightful-trace-bridge") return false;
  const params = data.params;
  switch (data.method) {
    case "progress":
      return isProgress(params);
    case "ready":
      return isRecord(params);
    case "model":
      return isRecord(params) && Array.isArray(params.contextEntries);
    case "error":
      return isRecord(params) && typeof params.error === "string";
    case "warm":
      return isRecord(params);
    case "fetchResult":
      return (
        isRecord(params) &&
        typeof params.id === "number" &&
        Number.isInteger(params.id) &&
        typeof params.ok === "boolean" &&
        typeof params.status === "number" &&
        Number.isFinite(params.status) &&
        (params.error === undefined || typeof params.error === "string")
      );
    default:
      return false;
  }
}

type PendingFetch = {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timeout: number;
};

function rejectAllPending(
  pending: Map<number, PendingFetch>,
  reason: string,
): void {
  for (const [, entry] of pending) {
    window.clearTimeout(entry.timeout);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

export function useTraceModel(traceUrl: string): {
  state: TraceModelState;
  bridge: TraceBridge;
} {
  const [state, setState] = useState<TraceModelState>({
    status: "loading",
    progress: null,
  });

  const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const activeTraceUrlRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<number, PendingFetch>());
  const nextIdRef = useRef(1);

  const readyTraceUrl = state.status === "ready" ? state.traceUrl : null;

  const bridge = useMemo<TraceBridge>(() => {
    const request = <T>(
      path: string,
      as: "json" | "blob",
      decode: (body: unknown) => T,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        const target = activeIframeRef.current?.contentWindow;
        if (!target) {
          reject(new Error("Trace bridge is not mounted."));
          return;
        }
        const id = nextIdRef.current++;
        const timeout = window.setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error("Timed out fetching from the trace."));
        }, BRIDGE_FETCH_TIMEOUT_MS);
        pendingRef.current.set(id, {
          resolve: (body) => {
            try {
              resolve(decode(body));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
          reject,
          timeout,
        });
        target.postMessage(
          { source: "wrightful-trace-host", method: "fetch", id, path, as },
          traceViewerBridgeOrigin(window.location.origin),
        );
      });
    return {
      fetchJson: (path) => request(path, "json", (body) => body),
      fetchBlob: (path) =>
        request(path, "blob", (body) => {
          if (!(body instanceof Blob)) {
            throw new Error("Trace bridge returned a non-Blob fetch body.");
          }
          return body;
        }),
      traceUrl: readyTraceUrl ?? "",
    };
  }, [readyTraceUrl]);

  // Keep fetch replies wired to the active bridge across attempt switches.
  useEffect(() => {
    const pending = pendingRef.current;

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== traceViewerBridgeOrigin(window.location.origin))
        return;
      if (event.source !== activeIframeRef.current?.contentWindow) return;
      if (!isBridgeMessage(event.data)) return;
      if (event.data.method !== "fetchResult") return;
      const params = event.data.params;
      const entry = pending.get(params.id);
      if (!entry) return;
      pending.delete(params.id);
      window.clearTimeout(entry.timeout);
      if (params.ok) {
        entry.resolve(params.body);
      } else {
        entry.reject(
          new Error(params.error ?? `Trace fetch failed (${params.status}).`),
        );
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      activeIframeRef.current?.remove();
      activeIframeRef.current = null;
      activeTraceUrlRef.current = null;
      rejectAllPending(pending, "Trace bridge unmounted.");
    };
  }, []);

  useEffect(() => {
    if (activeTraceUrlRef.current === traceUrl && activeIframeRef.current) {
      setState((prev) =>
        prev.status === "ready" ? { ...prev, switching: null } : prev,
      );
      return;
    }

    const isSwitch = activeTraceUrlRef.current !== null;
    setState((prev) =>
      isSwitch && prev.status === "ready"
        ? { ...prev, switching: { progress: null } }
        : { status: "loading", progress: null },
    );

    const iframe = mountBridgeIframe(traceUrl, "Trace loader");

    const becomeActive = (): void => {
      const previous = activeIframeRef.current;
      if (previous && previous !== iframe) {
        previous.remove();
        rejectAllPending(pendingRef.current, "Trace bridge unmounted.");
      }
      activeIframeRef.current = iframe;
    };

    if (!isSwitch) becomeActive();

    let done = false;
    const fail = (error: string): void => {
      done = true;
      becomeActive();
      activeTraceUrlRef.current = null;
      setState({ status: "error", error });
    };

    let watchdog = 0;
    const armWatchdog = (timeoutMs: number, error: string): void => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        if (done) return;
        fail(error);
      }, timeoutMs);
    };
    const armStartupWatchdog = (): void =>
      armWatchdog(
        BRIDGE_STARTUP_TIMEOUT_MS,
        "Timed out starting the trace viewer. Its service worker may be blocked in this browser.",
      );
    const armLoadWatchdog = (): void =>
      armWatchdog(
        TRACE_LOAD_SILENCE_TIMEOUT_MS,
        "Timed out loading the trace after the trace viewer became ready.",
      );
    armStartupWatchdog();

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== traceViewerBridgeOrigin(window.location.origin))
        return;
      if (event.source !== iframe.contentWindow) return;
      if (!isBridgeMessage(event.data)) return;
      const message = event.data;
      switch (message.method) {
        case "fetchResult":
        case "warm":
          return;
        case "ready":
          if (done) return;
          armLoadWatchdog();
          return;
        case "progress":
          if (done) return;
          armLoadWatchdog();
          setState((prev) =>
            isSwitch && prev.status === "ready"
              ? { ...prev, switching: { progress: message.params } }
              : { status: "loading", progress: message.params },
          );
          return;
        case "model":
          if (done) return;
          done = true;
          window.clearTimeout(watchdog);
          becomeActive();
          activeTraceUrlRef.current = traceUrl;
          setState({
            status: "ready",
            traceUrl,
            contextEntries: message.params.contextEntries,
            switching: null,
          });
          return;
        case "error":
          if (done) return;
          window.clearTimeout(watchdog);
          fail(message.params.error);
          return;
        default:
          return;
      }
    };

    window.addEventListener("message", onMessage);

    return () => {
      done = true;
      window.clearTimeout(watchdog);
      window.removeEventListener("message", onMessage);
      // Active iframes are retired by the next switch or the persistent effect.
      if (activeIframeRef.current !== iframe) iframe.remove();
    };
  }, [traceUrl]);

  return { state, bridge };
}

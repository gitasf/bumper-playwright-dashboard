"use client";

import { useEffect, useRef, useState } from "react";
import type { TraceBridge } from "./use-trace-model";

/**
 * The canonical "fetch trace bytes through the bridge into state" shape.
 * The result is stored keyed on `key` and the return value is gated on it,
 * so a key change can never render the previous key's value — the exact
 * stale-frame bug this hook exists to prevent (`use-object-url.ts` is the
 * same shape specialized for object URLs, which additionally owns
 * revocation). `key` may be null to skip fetching entirely.
 *
 * `load` is read through a ref: only `bridge`/`key` changes trigger a fetch,
 * and the loader captured is always the latest render's (so closing over
 * props like `bridge`/`traceUrl` inside it is safe) — which means the key
 * must encode every input the loader reads, since nothing else ever
 * triggers a refetch.
 */
export function useBridgeFetch<T>(
  bridge: TraceBridge,
  key: string | null,
  load: (key: string) => Promise<T>,
): { value: T | undefined; error: Error | undefined } {
  const [result, setResult] = useState<{
    key: string;
    value?: T;
    error?: Error;
  } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    loadRef
      .current(key)
      .then((value) => {
        if (!cancelled) setResult({ key, value });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          key,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, key]);

  return result?.key === key
    ? { value: result.value, error: result.error }
    : { value: undefined, error: undefined };
}

/** {@link useBridgeFetch} specialized to a trace path fetched as text. */
export function useBridgeText(
  bridge: TraceBridge,
  path: string | null,
): { text: string | undefined; error: Error | undefined } {
  const { value, error } = useBridgeFetch(bridge, path, (target) =>
    bridge.fetchBlob(target).then((blob) => blob.text()),
  );
  return { text: value, error };
}

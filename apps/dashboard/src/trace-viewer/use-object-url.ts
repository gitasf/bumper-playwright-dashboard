"use client";

import { useEffect, useRef, useState } from "react";
import type { TraceBridge } from "./use-trace-model";

/**
 * Fetch trace bytes (a `sha1/…` path) through the bridge proxy and expose them
 * as an object URL for `<img>`/`<video>`/download use. The URL is revoked on
 * path change and on unmount; a path change returns `null` until the new blob
 * resolves. `path` may be null to skip (renders nothing yet).
 *
 * Object URLs are per-hook (not globally cached): revocation stays trivially
 * correct, and repeat fetches are cheap — the SW serves sha1 blobs from its
 * in-memory trace, and same-URL requests hit the browser's HTTP cache inside
 * the bridge. For a flash-free swap that keeps the previous frame on screen
 * across a path change (the filmstrip across an attempt swap), use
 * {@link useBufferedObjectUrl} instead.
 */
export function useObjectUrl(
  bridge: TraceBridge,
  path: string | null,
): { url: string | null; error: boolean } {
  const [result, setResult] = useState<{
    path: string;
    url: string | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!path) {
      setResult(null);
      return;
    }
    let cancelled = false;
    // Created inside the `.then` AFTER the cancel check, so a superseded fetch
    // never mints a URL — nothing to leak. Revoked from this effect's cleanup.
    let objectUrl: string | null = null;
    bridge
      .fetchBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ path, url: objectUrl, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ path, url: null, error: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, path]);

  return result?.path === path
    ? { url: result.url, error: result.error }
    : { url: null, error: false };
}

/**
 * Like {@link useObjectUrl}, but on a path change keeps returning the PREVIOUS
 * resolved object URL — instead of dropping to `null` — until the new blob
 * resolves, then swaps to it and revokes the old one (revoke-after-replace).
 *
 * The displayed URL is held in a ref, not revoked from the per-path effect's
 * cleanup, so a path change never revokes a URL that's still on screen; a blob
 * that resolves for a path the hook has since moved away from is never turned
 * into an object URL (the `cancelled` guard), so nothing leaks. The unmount
 * cleanup is the one place that revokes whatever is currently displayed. (A
 * failed new path still surfaces as `{ url: null, error: true }` — the
 * hold-previous behavior applies only while a fetch is genuinely in flight.)
 *
 * Use for a flash-free swap (the timeline filmstrip, whose slots are keyed by
 * index and outlive an attempt swap); prefer plain {@link useObjectUrl}
 * otherwise.
 */
export function useBufferedObjectUrl(
  bridge: TraceBridge,
  path: string | null,
): { url: string | null; error: boolean } {
  const [result, setResult] = useState<{
    url: string | null;
    error: boolean;
  } | null>(null);
  const displayedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    // No replacement in flight — keep showing whatever was last displayed.
    if (!path) return;
    let cancelled = false;
    bridge
      .fetchBlob(path)
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        const previous = displayedUrlRef.current;
        if (previous) URL.revokeObjectURL(previous);
        displayedUrlRef.current = objectUrl;
        setResult({ url: objectUrl, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ url: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, path]);

  // The displayed URL has no later "next resolve" to hand cleanup off to once
  // the hook goes away, so this is the one place that revokes it.
  useEffect(() => {
    return () => {
      if (displayedUrlRef.current) URL.revokeObjectURL(displayedUrlRef.current);
    };
  }, []);

  return result ?? { url: null, error: false };
}

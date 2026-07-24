"use client";

import React from "react";
import { cn } from "@/lib/cn";

/**
 * Avatar tile: a fixed-size rounded box holding an optional photo
 * ({@link AvatarImage}) layered over an always-rendered {@link AvatarFallback}.
 *
 * Deliberately NOT built on Base UI's `Avatar` primitive. That primitive's
 * Root/Fallback exist only to coordinate an image-loading status — the Fallback
 * hides once the status flips to `'loaded'`. Our `AvatarImage` is a native
 * `<img>` (for SSR-first loading, see its docs) that never feeds that status,
 * so the fallback stays rendered forever anyway. Plain `<span>`s make the
 * "fallback is the permanent base layer" contract self-evident instead of a
 * side effect of an unused primitive, and drop the dependency.
 */
export function Avatar({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">): React.ReactElement {
  return (
    <span
      className={cn(
        "relative inline-flex size-8 shrink-0 select-none items-center justify-center overflow-hidden rounded-md bg-background align-middle font-medium text-xs",
        className,
      )}
      data-slot="avatar"
      {...props}
    />
  );
}

/**
 * Avatar image, rendered as a native `<img>` (not Base UI's `Avatar.Image`).
 *
 * Base UI's `Avatar.Image` renders `null` on the server and only requests the
 * image from a client effect *after* hydration, so the browser's preload
 * scanner never sees the `src` and the fetch is gated behind bundle download +
 * hydrate. A plain `<img>` ships in the SSR HTML, so the fetch starts on first
 * paint. It sits absolutely over the fallback tile (the `Avatar` root is
 * `relative`, so the tile shows through until the photo paints and is revealed
 * again if the photo fails). On load failure the image unmounts; the failure is
 * keyed to `src` (not a bare flag) so a later `src` change re-attempts the new
 * photo instead of staying blank. The mount check catches failures that fired
 * before hydration wired up `onError`.
 */
export function AvatarImage({
  className,
  onError,
  alt = "",
  ...props
}: React.ComponentPropsWithoutRef<"img">): React.ReactElement | null {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLImageElement>(null);
  React.useEffect(() => {
    // Re-runs on `src` change (the <img> node is reused across swaps), catching
    // a failure that resolved before hydration wired up `onError`.
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) {
      setFailedSrc(props.src ?? null);
    }
  }, [props.src]);
  if (props.src != null && failedSrc === props.src) {
    return null;
  }
  return (
    <img
      ref={ref}
      alt={alt}
      className={cn("absolute inset-0 size-full object-cover", className)}
      data-slot="avatar-image"
      onError={(event) => {
        setFailedSrc(props.src ?? null);
        onError?.(event);
      }}
      {...props}
    />
  );
}

/**
 * The permanent base layer under {@link AvatarImage}: always rendered, shows
 * through until the photo paints and is revealed again if the photo fails.
 */
export function AvatarFallback({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">): React.ReactElement {
  return (
    <span
      className={cn(
        "flex size-full items-center justify-center rounded-md bg-muted",
        className,
      )}
      data-slot="avatar-fallback"
      {...props}
    />
  );
}

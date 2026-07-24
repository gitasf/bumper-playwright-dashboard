"use client";

import { useEffect, useState } from "react";

/**
 * Observe an element's rendered size via ResizeObserver. Returns `null`
 * until the first measurement. Reads `clientWidth`/`clientHeight` (the
 * content box as laid out) so both trace-viewer consumers — the timeline
 * strip and the snapshot stage — measure the same way.
 */
export function useElementSize(
  ref: React.RefObject<HTMLElement | null>,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: node.clientWidth, height: node.clientHeight });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

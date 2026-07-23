"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Transient "Copied" feedback flag for copy-to-clipboard buttons. `flash()`
 * sets the flag and clears it after `durationMs`. The timer is tracked in a
 * ref so a re-click resets the window (no stacked timeouts racing each other)
 * and unmount clears the pending timer (no setState on an unmounted
 * component). Shared by the artifact copy buttons + terminal block.
 */
export function useCopiedFlag(durationMs = 1500): {
  copied: boolean;
  flash: () => void;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const flash = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, durationMs);
  }, [durationMs]);

  return { copied, flash };
}

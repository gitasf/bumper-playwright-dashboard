"use client";

import { useEffect } from "react";

/**
 * Global ⌘K / Ctrl+K shortcut. Toggles the command menu open via the setter
 * without coupling the layout to keyboard plumbing.
 *
 * Lives in its own light module (not `command-menu.tsx`) so `app-layout` can
 * register the shortcut without statically importing the heavy `<CommandMenu>`
 * (Base UI Combobox machinery) — the menu itself is `React.lazy`-loaded and
 * only mounted on first open, so it stays out of the every-page layout bundle.
 */
export function useCommandMenuShortcut(
  setOpen: (updater: (open: boolean) => boolean) => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isK = e.key === "k" || e.key === "K";
      if (!isK) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setOpen]);
}

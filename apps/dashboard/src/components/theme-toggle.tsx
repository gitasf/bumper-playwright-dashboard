import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { applyTheme, isDarkApplied, persistTheme } from "@/lib/theme";

/**
 * Reads the current theme from `<html class>` on mount (which the inline
 * script in `middleware/01.head.ts` has already set from localStorage),
 * then mirrors changes back to both the class and localStorage on toggle.
 *
 * Keeping the source-of-truth on `document.documentElement.classList` rather
 * than React state means a useEffect-driven hydration mismatch can't flash
 * the wrong icon: we read whatever the FOUC-killer script chose.
 */
export function ThemeToggle({
  variant = "menu-row",
}: {
  variant?: "menu-row" | "icon-button";
}) {
  const [isDark, setIsDark] = useState<boolean | null>(null);

  useEffect(() => {
    setIsDark(isDarkApplied());
  }, []);

  const toggle = () => {
    const next = !isDarkApplied();

    // Suppress every transition + animation across the document while we flip
    // the theme class. Without this, anything with `transition-colors` (most
    // Base UI primitives, sidebar nav rows, buttons) animates between the
    // old and new palette instead of swapping atomically. We inject a global
    // override stylesheet, force a reflow so it's applied before the class
    // change, then remove it on the next frame once the swap has painted.
    const disable = document.createElement("style");
    disable.appendChild(
      document.createTextNode(
        "*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}",
      ),
    );
    document.head.appendChild(disable);

    applyTheme(next);

    // Force a reflow so the disable rule + class change land in the same paint.
    void window.getComputedStyle(document.body).backgroundColor;

    window.requestAnimationFrame(() => {
      document.head.removeChild(disable);
    });

    persistTheme(next);
    setIsDark(next);
  };

  // Render a neutral placeholder before hydration finishes so the swapped
  // icon doesn't pop in. Using a static `Moon` is fine here because the
  // user can't interact with it yet.
  const showDark = isDark ?? true;
  const Icon = showDark ? SunIcon : MoonIcon;
  const label = showDark ? "Switch to light" : "Switch to dark";

  if (variant === "icon-button") {
    return (
      <button
        aria-label={label}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={toggle}
        title={label}
        type="button"
      >
        <Icon className="size-3.5" />
      </button>
    );
  }

  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        "text-foreground hover:bg-accent",
      )}
      onClick={toggle}
      type="button"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span>{label}</span>
    </button>
  );
}

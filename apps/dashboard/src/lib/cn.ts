import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The app's type ramp uses role-named font-size tokens (`text-caption`,
// `text-body`, … — see the `@theme` block in `styles.css`). tailwind-merge
// doesn't know these are font sizes, so out of the box it classifies e.g.
// `text-caption` as a text *color* and drops it when it collides with a real color like
// `text-fg-1` (`twMerge("text-caption text-fg-1") === "text-fg-1"`) — silently
// leaving the element at the inherited default size. Registering the ramp with
// the `font-size` group fixes the classification so a size and a color survive
// together while size-vs-size still collapses to the last one.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-micro",
        "text-caption",
        "text-body",
        "text-body-lg",
        "text-heading",
        "text-title",
        "text-display",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

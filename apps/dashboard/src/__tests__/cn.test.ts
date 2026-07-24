import { describe, expect, it } from "vitest";
import { cn } from "@/lib/cn";

describe("cn", () => {
  // Regression: tailwind-merge classifies the app's role-named font-size
  // tokens (`text-caption`, …) as a *color* out of the box, so it drops them when
  // they collide with an actual text color. `cn` registers the ramp with the
  // font-size group so a size and a color survive together.
  it("keeps a ramp font-size token alongside a text color", () => {
    expect(cn("text-caption text-fg-1")).toBe("text-caption text-fg-1");
    expect(cn("text-micro text-fg-4")).toBe("text-micro text-fg-4");
    expect(cn("text-body-lg text-fg-2")).toBe("text-body-lg text-fg-2");
  });

  it("still collapses conflicting font sizes to the last one", () => {
    expect(cn("text-caption text-body")).toBe("text-body");
    expect(cn("text-sm text-caption")).toBe("text-caption");
  });

  it("still collapses conflicting text colors to the last one", () => {
    expect(cn("text-fg-1 text-fg-2")).toBe("text-fg-2");
  });
});

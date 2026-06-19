import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACT,
  DENSITY_COMPACT_CLASS,
  DENSITY_STORAGE_KEY,
  DENSITY_VALUE_COMPACT,
  densityValue,
  prefersCompact,
} from "@/lib/density";
import { themeInitScript } from "@/lib/theme-init-script";

/**
 * Density contract (roadmap 4.1b), the exact sibling of `theme.test.ts`. The
 * no-FOUC guarantee requires the inline boot script and the runtime toggle to
 * agree on key/class/default — both derive from these constants, so this pins
 * that they stay in lockstep.
 */
describe("density contract", () => {
  describe("prefersCompact (the compact-off-by-default rule)", () => {
    it("defaults to DEFAULT_COMPACT when no preference is stored", () => {
      expect(prefersCompact(null)).toBe(DEFAULT_COMPACT);
    });

    it("honours an explicit stored preference", () => {
      expect(prefersCompact("compact")).toBe(true);
      expect(prefersCompact("comfortable")).toBe(false);
    });

    it("treats any unrecognised value as not-compact", () => {
      expect(prefersCompact("garbage")).toBe(false);
      expect(prefersCompact("")).toBe(DEFAULT_COMPACT); // empty string is falsy -> default
    });
  });

  describe("densityValue", () => {
    it("maps the boolean to the persisted string", () => {
      expect(densityValue(true)).toBe("compact");
      expect(densityValue(false)).toBe("comfortable");
    });
  });

  describe("themeInitScript derives from the density contract constants", () => {
    it("reads the density storage key from DENSITY_STORAGE_KEY", () => {
      expect(themeInitScript).toContain(
        `localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)})`,
      );
    });

    it("tests against DENSITY_VALUE_COMPACT with the DEFAULT_COMPACT fallback", () => {
      expect(themeInitScript).toContain(
        `n?n===${JSON.stringify(DENSITY_VALUE_COMPACT)}:${JSON.stringify(DEFAULT_COMPACT)}`,
      );
    });

    it("toggles DENSITY_COMPACT_CLASS on the document element", () => {
      expect(themeInitScript).toContain(
        `classList.toggle(${JSON.stringify(DENSITY_COMPACT_CLASS)},c)`,
      );
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  DARK_CLASS,
  DEFAULT_DARK,
  prefersDark,
  THEME_STORAGE_KEY,
  THEME_VALUE_DARK,
  themeValue,
} from "@/lib/theme";
import { themeInitScript } from "@/lib/theme-init-script";

describe("theme contract", () => {
  describe("prefersDark (the dark-by-default rule)", () => {
    it("defaults to DEFAULT_DARK when no preference is stored", () => {
      expect(prefersDark(null)).toBe(DEFAULT_DARK);
    });

    it("honours an explicit stored preference", () => {
      expect(prefersDark("dark")).toBe(true);
      expect(prefersDark("light")).toBe(false);
    });

    it("treats any unrecognised value as not-dark", () => {
      expect(prefersDark("garbage")).toBe(false);
      expect(prefersDark("")).toBe(DEFAULT_DARK); // empty string is falsy -> default
    });
  });

  describe("themeValue", () => {
    it("maps the boolean to the persisted string", () => {
      expect(themeValue(true)).toBe("dark");
      expect(themeValue(false)).toBe("light");
    });
  });

  // The no-FOUC guarantee requires the inline boot script and the runtime toggle
  // to agree on key/class/default. The script is derived from the same constants,
  // so this pins that they stay in lockstep: if a constant changes, the generated
  // script changes with it (and this test still passes); if someone hand-edits the
  // script back to a literal, these assertions break.
  describe("themeInitScript derives from the contract constants", () => {
    it("reads the storage key from THEME_STORAGE_KEY", () => {
      expect(themeInitScript).toContain(
        `localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})`,
      );
    });

    it("tests against THEME_VALUE_DARK with the DEFAULT_DARK fallback", () => {
      expect(themeInitScript).toContain(
        `t?t===${JSON.stringify(THEME_VALUE_DARK)}:${JSON.stringify(DEFAULT_DARK)}`,
      );
    });

    it("toggles DARK_CLASS on the document element", () => {
      expect(themeInitScript).toContain(
        `classList.toggle(${JSON.stringify(DARK_CLASS)},d)`,
      );
    });
  });
});

import { describe, expect, it } from "vite-plus/test";
import { makeHrefBuilder } from "@/lib/page-links";

const PATH = "/t/acme/p/web/insights";

describe("makeHrefBuilder", () => {
  describe("with()", () => {
    it("seeds from the current params, dropping absent/empty entries", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        range: "30d",
        segment: "day",
        branch: null,
        q: "",
      });
      // null branch + empty q are omitted; range + segment survive.
      expect(href()).toBe(`${PATH}?range=30d&segment=day`);
    });

    it("treats null, undefined and empty string as absent", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        range: "7d",
        branch: undefined,
        q: null,
        env: "",
      });
      expect(href()).toBe(`${PATH}?range=7d`);
    });

    it("returns the bare pathname (no '?') when nothing is present", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        branch: null,
        tab: undefined,
      });
      expect(href()).toBe(PATH);
    });

    it("overrides a key while preserving the other active params", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        range: "30d",
        segment: "day",
        branch: "main",
      });
      expect(href({ segment: "week" })).toBe(
        `${PATH}?range=30d&segment=week&branch=main`,
      );
    });

    it("adds a new key not present in the seed", () => {
      const { with: href } = makeHrefBuilder(PATH, { range: "30d" });
      expect(href({ branch: "feature/x" })).toBe(
        `${PATH}?range=30d&branch=feature%2Fx`,
      );
    });

    it("drops a key when the override value is null", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        range: "30d",
        branch: "main",
      });
      expect(href({ branch: null })).toBe(`${PATH}?range=30d`);
    });

    it("drops a key when the override value is an empty string", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        range: "30d",
        page: "3",
      });
      expect(href({ page: "" })).toBe(`${PATH}?range=30d`);
    });

    it("can drop the last param and fall back to the bare pathname", () => {
      const { with: href } = makeHrefBuilder(PATH, { tab: "env" });
      expect(href({ tab: null })).toBe(PATH);
    });

    it("preserves seed order and appends new override keys", () => {
      const { with: href } = makeHrefBuilder(PATH, {
        range: "30d",
        segment: "day",
      });
      expect(href({ branch: "main" })).toBe(
        `${PATH}?range=30d&segment=day&branch=main`,
      );
    });
  });

  describe("pageHref()", () => {
    it("drops the page key for page 1 (the default)", () => {
      const { pageHref } = makeHrefBuilder(PATH, {
        range: "30d",
        page: "4",
      });
      expect(pageHref(1)).toBe(`${PATH}?range=30d`);
    });

    it("sets the page key for pages > 1, keeping other params", () => {
      const { pageHref } = makeHrefBuilder(PATH, {
        range: "30d",
        branch: "main",
      });
      expect(pageHref(3)).toBe(`${PATH}?range=30d&branch=main&page=3`);
    });

    it("returns the bare pathname for page 1 when no other params", () => {
      const { pageHref } = makeHrefBuilder(PATH, {});
      expect(pageHref(1)).toBe(PATH);
    });
  });
});

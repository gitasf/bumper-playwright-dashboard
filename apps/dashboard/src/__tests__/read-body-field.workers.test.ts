import type { Context } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { readBodyField } from "@/lib/form";

/**
 * `readBodyField` is the dual-mode body reader behind the two owner-only mint
 * endpoints (`/api/teams/:teamSlug/p/:projectSlug/keys` reads `label`;
 * `/api/teams/:teamSlug/invites` reads `identifier`/`inviteIdentifier`). Both
 * previously open-coded the same content-type sniff + unsafe JSON cast +
 * typeof-string guard + FormData fallback. This concentrates that into one
 * surface, and these tests pin the contract:
 *
 *  - `application/json`  -> reads `json[jsonKey]`, trims, non-string -> "".
 *  - anything else       -> reads `formData[formKey]` via readField, trims.
 *  - malformed JSON THROWS (preserves the propagate-to-00.errors.ts contract;
 *    a missing/non-string field is "", but a parse error is NOT swallowed).
 *
 * The fn takes a Hono `Context`, but only touches `c.req.header/json/formData`,
 * so a minimal stub keeps it unit-testable without a live request.
 */

/** Build a minimal `c` whose `req` exposes header/json/formData. */
function makeContext(opts: {
  contentType?: string | null;
  json?: () => Promise<unknown>;
  form?: FormData;
}): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "content-type"
          ? (opts.contentType ?? undefined)
          : undefined,
      json:
        opts.json ?? (() => Promise.reject(new Error("json() not stubbed"))),
      formData: () => Promise.resolve(opts.form ?? new FormData()),
    },
  } as unknown as Context;
}

const KEYS = { jsonKey: "label", formKey: "label" } as const;
const INVITE = { jsonKey: "identifier", formKey: "inviteIdentifier" } as const;

describe("readBodyField (application/json path)", () => {
  it("reads and trims the json field by jsonKey", async () => {
    const c = makeContext({
      contentType: "application/json",
      json: () => Promise.resolve({ label: "  CI key  " }),
    });
    expect(await readBodyField(c, KEYS)).toBe("CI key");
  });

  it("uses jsonKey, not formKey, on the JSON branch", async () => {
    // inviteIdentifier (the form key) present but identifier (json key) absent.
    const c = makeContext({
      contentType: "application/json",
      json: () => Promise.resolve({ inviteIdentifier: "octocat" }),
    });
    expect(await readBodyField(c, INVITE)).toBe("");
  });

  it("returns '' when the json field is missing", async () => {
    const c = makeContext({
      contentType: "application/json",
      json: () => Promise.resolve({}),
    });
    expect(await readBodyField(c, KEYS)).toBe("");
  });

  it.each([42, true, null, { nested: 1 }, ["arr"]])(
    "returns '' when the json field is non-string (%j)",
    async (value) => {
      const c = makeContext({
        contentType: "application/json",
        json: () => Promise.resolve({ label: value }),
      });
      expect(await readBodyField(c, KEYS)).toBe("");
    },
  );

  it("sniffs application/json even with a charset suffix", async () => {
    const c = makeContext({
      contentType: "application/json; charset=utf-8",
      json: () => Promise.resolve({ label: "x" }),
    });
    expect(await readBodyField(c, KEYS)).toBe("x");
  });

  it("propagates a malformed-JSON parse error (does not swallow to '')", async () => {
    const c = makeContext({
      contentType: "application/json",
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });
    await expect(readBodyField(c, KEYS)).rejects.toThrow(SyntaxError);
  });
});

describe("readBodyField (FormData path)", () => {
  it("reads and trims the form field by formKey when content-type is form", async () => {
    const form = new FormData();
    form.set("inviteIdentifier", "  octocat  ");
    const c = makeContext({
      contentType: "application/x-www-form-urlencoded",
      form,
    });
    expect(await readBodyField(c, INVITE)).toBe("octocat");
  });

  it("falls back to FormData when content-type is absent", async () => {
    const form = new FormData();
    form.set("label", "from form");
    const c = makeContext({ contentType: null, form });
    expect(await readBodyField(c, KEYS)).toBe("from form");
  });

  it("uses formKey, not jsonKey, on the FormData branch", async () => {
    const form = new FormData();
    form.set("identifier", "wrong-key");
    const c = makeContext({ contentType: "multipart/form-data", form });
    // identifier is the json key; only inviteIdentifier should be read here.
    expect(await readBodyField(c, INVITE)).toBe("");
  });

  it("returns '' when a File is uploaded under the form key", async () => {
    const form = new FormData();
    form.set("label", new File(["x"], "x.txt"));
    const c = makeContext({ contentType: "multipart/form-data", form });
    expect(await readBodyField(c, KEYS)).toBe("");
  });

  it("returns '' when the form field is absent", async () => {
    const c = makeContext({ contentType: "", form: new FormData() });
    expect(await readBodyField(c, KEYS)).toBe("");
  });
});

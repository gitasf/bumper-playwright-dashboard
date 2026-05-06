import { describe, expect, it, vi, beforeEach } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: {} as { ALLOW_OPEN_SIGNUP?: string },
}));
vi.mock("cloudflare:workers", () => ({ env: envMock }));

import { isOpenSignupAllowed } from "@/lib/signup";

beforeEach(() => {
  for (const k of Object.keys(envMock)) {
    delete (envMock as Record<string, unknown>)[k];
  }
});

describe("isOpenSignupAllowed", () => {
  it("is false when ALLOW_OPEN_SIGNUP is unset", () => {
    expect(isOpenSignupAllowed()).toBe(false);
  });

  it.each(["", "0", "false", "no", "off", "FALSE", "anything-else"])(
    "is false for falsy value %j",
    (value) => {
      envMock.ALLOW_OPEN_SIGNUP = value;
      expect(isOpenSignupAllowed()).toBe(false);
    },
  );

  it.each(["1", "true", "TRUE", "yes", "on", " on ", "On"])(
    "is true for truthy value %j",
    (value) => {
      envMock.ALLOW_OPEN_SIGNUP = value;
      expect(isOpenSignupAllowed()).toBe(true);
    },
  );
});

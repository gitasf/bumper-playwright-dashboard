import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  deliverEmail,
  type EmailBinding,
  isEmailConfigured,
  sendEmail,
  type SendEmailParams,
} from "@/lib/email";

// `cloudflare:workers` (the `EMAIL` binding) and `void/env` (`EMAIL_FROM`) are
// the two inputs `sendEmail`/`isEmailConfigured` resolve at call time. We back
// them with mutable objects reset per test so one file can cover both the
// configured and unconfigured states. `void/log` is mocked to assert the
// log-and-rethrow on transport failure (CLAUDE.md: route caught errors through
// `logger.*`). The objects live in `vi.hoisted` so they're initialized above
// the hoisted `vi.mock` factories that return them by reference (a plain
// `const` would be in the TDZ when the factory eagerly reads it).
const { bindingEnv, config, errorSpy } = vi.hoisted(() => ({
  bindingEnv: {} as Record<string, unknown>,
  config: {} as Record<string, unknown>,
  errorSpy: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: bindingEnv }));
vi.mock("void/env", () => ({ env: config }));
vi.mock("void/log", () => ({
  logger: { error: errorSpy, warn: vi.fn(), info: vi.fn() },
}));

function fakeBinding(impl?: EmailBinding["send"]): {
  binding: EmailBinding;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(impl ?? (() => Promise.resolve({ messageId: "m_1" })));
  return { binding: { send }, send };
}

const params: SendEmailParams = {
  to: "alice@example.com",
  subject: "Verify your email",
  html: "<p>hi</p>",
  text: "hi",
};

beforeEach(() => {
  errorSpy.mockClear();
  delete bindingEnv.EMAIL;
  delete config.EMAIL_FROM;
});

describe("deliverEmail", () => {
  it("forwards from/to/subject/html/text to the binding and returns its result", async () => {
    const { binding, send } = fakeBinding(() =>
      Promise.resolve({ messageId: "m_42" }),
    );

    const result = await deliverEmail(binding, "noreply@wrightful.dev", params);

    expect(result).toEqual({ messageId: "m_42" });
    expect(send).toHaveBeenCalledWith({
      from: "noreply@wrightful.dev",
      to: "alice@example.com",
      subject: "Verify your email",
      html: "<p>hi</p>",
      text: "hi",
    });
  });

  it("passes an array of recipients through unchanged", async () => {
    const { binding, send } = fakeBinding();

    await deliverEmail(binding, "noreply@wrightful.dev", {
      ...params,
      to: ["a@example.com", "b@example.com"],
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["a@example.com", "b@example.com"] }),
    );
  });

  it("logs (with recipients + subject) and rethrows when the binding throws", async () => {
    const { binding } = fakeBinding(() =>
      Promise.reject(new Error("CES rejected")),
    );

    await expect(
      deliverEmail(binding, "noreply@wrightful.dev", {
        ...params,
        to: ["a@example.com", "b@example.com"],
      }),
    ).rejects.toThrow("CES rejected");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "email send failed",
      expect.objectContaining({
        to: "a@example.com, b@example.com",
        subject: "Verify your email",
        message: "CES rejected",
      }),
    );
  });
});

describe("isEmailConfigured", () => {
  it("is false when the binding is absent", () => {
    config.EMAIL_FROM = "noreply@wrightful.dev";
    expect(isEmailConfigured()).toBe(false);
  });

  it("is false when EMAIL_FROM is unset", () => {
    bindingEnv.EMAIL = fakeBinding().binding;
    expect(isEmailConfigured()).toBe(false);
  });

  it("is true when both the binding and EMAIL_FROM are present", () => {
    bindingEnv.EMAIL = fakeBinding().binding;
    config.EMAIL_FROM = "noreply@wrightful.dev";
    expect(isEmailConfigured()).toBe(true);
  });
});

describe("sendEmail", () => {
  it("skips gracefully (no throw, no send) when the binding is missing", async () => {
    const { send } = fakeBinding();
    config.EMAIL_FROM = "noreply@wrightful.dev"; // from set, but no binding

    const result = await sendEmail(params);

    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips gracefully when EMAIL_FROM is unset", async () => {
    const { binding, send } = fakeBinding();
    bindingEnv.EMAIL = binding; // binding present, but no from

    const result = await sendEmail(params);

    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("defaults from to EMAIL_FROM and reports the messageId on success", async () => {
    const { binding, send } = fakeBinding(() =>
      Promise.resolve({ messageId: "m_99" }),
    );
    bindingEnv.EMAIL = binding;
    config.EMAIL_FROM = "Wrightful <noreply@wrightful.dev>";

    const result = await sendEmail(params);

    expect(result).toEqual({ sent: true, messageId: "m_99" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Wrightful <noreply@wrightful.dev>" }),
    );
  });

  it("lets params.from override EMAIL_FROM", async () => {
    const { binding, send } = fakeBinding();
    bindingEnv.EMAIL = binding;
    config.EMAIL_FROM = "noreply@wrightful.dev";

    await sendEmail({ ...params, from: "alerts@wrightful.dev" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ from: "alerts@wrightful.dev" }),
    );
  });

  it("propagates a transport failure when email IS configured", async () => {
    const { binding } = fakeBinding(() => Promise.reject(new Error("boom")));
    bindingEnv.EMAIL = binding;
    config.EMAIL_FROM = "noreply@wrightful.dev";

    await expect(sendEmail(params)).rejects.toThrow("boom");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

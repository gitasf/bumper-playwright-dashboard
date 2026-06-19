import { describe, expect, it } from "vite-plus/test";
import {
  CreateMonitorSchema,
  type CreateHttpMonitorInput,
  type CreateTcpMonitorInput,
} from "@/lib/monitors/monitor-schemas";
import {
  formType,
  httpConfigFromForm,
  parseAssertionsField,
  tcpConfigFromForm,
} from "@/lib/monitors/monitor-form-parse";

/**
 * The FormData → schema-input glue the create/edit actions use. The coalescing
 * here is load-bearing: get it wrong and a stored config silently flips (e.g. an
 * unchecked "follow redirects" staying true). These pin that, plus the
 * round-trip through `CreateMonitorSchema`'s http branch.
 */

function fd(entries: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
}

describe("formType", () => {
  it("returns http/tcp for an explicit type, browser otherwise", () => {
    expect(formType(fd({ type: "http" }))).toBe("http");
    expect(formType(fd({ type: "tcp" }))).toBe("tcp");
    expect(formType(fd({ type: "browser" }))).toBe("browser");
    expect(formType(fd({}))).toBe("browser");
    // An unknown / reserved value defaults to browser.
    expect(formType(fd({ type: "ping" }))).toBe("browser");
  });
});

describe("parseAssertionsField", () => {
  it("returns [] for a missing / blank / non-string field", () => {
    expect(parseAssertionsField(null)).toEqual([]);
    expect(parseAssertionsField("")).toEqual([]);
    expect(parseAssertionsField("   ")).toEqual([]);
  });

  it("parses a JSON array", () => {
    expect(
      parseAssertionsField(
        JSON.stringify([
          { source: "STATUS_CODE", comparison: "EQUALS", target: "200" },
        ]),
      ),
    ).toEqual([{ source: "STATUS_CODE", comparison: "EQUALS", target: "200" }]);
  });

  it("returns malformed JSON verbatim so the schema rejects it (never throws)", () => {
    expect(parseAssertionsField("{not json")).toBe("{not json");
  });
});

describe("httpConfigFromForm — checkbox + numeric coalescing", () => {
  it("treats an absent checkbox as false (not the schema default), present 'on' as true", () => {
    const off = httpConfigFromForm(fd({ url: "https://example.com" }));
    expect(off.followRedirects).toBe("");
    expect(off.shouldFail).toBe("");

    const on = httpConfigFromForm(
      fd({
        url: "https://example.com",
        followRedirects: "on",
        shouldFail: "on",
      }),
    );
    expect(on.followRedirects).toBe("on");
    expect(on.shouldFail).toBe("on");
  });

  it("passes numeric fields through, undefined when absent (so schema defaults apply)", () => {
    const present = httpConfigFromForm(
      fd({
        url: "https://example.com",
        degradedResponseTimeMs: "1000",
        maxResponseTimeMs: "2000",
      }),
    );
    expect(present.degradedResponseTimeMs).toBe("1000");
    expect(present.maxResponseTimeMs).toBe("2000");

    const absent = httpConfigFromForm(fd({ url: "https://example.com" }));
    expect(absent.degradedResponseTimeMs).toBeUndefined();
    expect(absent.maxResponseTimeMs).toBeUndefined();
  });
});

describe("round-trip through CreateMonitorSchema (http branch)", () => {
  it("an unchecked follow-redirects ends up FALSE, not the schema's default(true)", () => {
    const form = fd({
      type: "http",
      name: "Homepage",
      intervalSeconds: "60",
      url: "https://example.com",
      // no followRedirects field (switch off) → must NOT default to true
    });
    const parsed = CreateMonitorSchema.safeParse({
      type: formType(form),
      name: form.get("name"),
      intervalSeconds: form.get("intervalSeconds"),
      enabled: form.get("enabled") ?? "",
      config: httpConfigFromForm(form),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "http") {
      const config = (parsed.data as CreateHttpMonitorInput).config;
      expect(config.followRedirects).toBe(false);
      // numeric defaults still apply when the field was absent
      expect(config.degradedResponseTimeMs).toBe(3000);
      expect(config.maxResponseTimeMs).toBe(5000);
    }
  });

  it("assembles assertions from the hidden JSON field", () => {
    const form = fd({
      type: "http",
      name: "API",
      intervalSeconds: "300",
      url: "https://example.com/api",
      followRedirects: "on",
      assertions: JSON.stringify([
        {
          source: "JSON_BODY",
          property: "$.ok",
          comparison: "EQUALS",
          target: "true",
        },
      ]),
    });
    const parsed = CreateMonitorSchema.safeParse({
      type: formType(form),
      name: form.get("name"),
      intervalSeconds: form.get("intervalSeconds"),
      enabled: form.get("enabled") ?? "",
      config: httpConfigFromForm(form),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "http") {
      const config = (parsed.data as CreateHttpMonitorInput).config;
      expect(config.followRedirects).toBe(true);
      expect(config.assertions).toHaveLength(1);
      expect(config.assertions[0]?.source).toBe("JSON_BODY");
    }
  });
});

describe("tcpConfigFromForm — host/port/timeout coalescing", () => {
  it("passes host verbatim and numeric fields through, undefined when absent", () => {
    const present = tcpConfigFromForm(
      fd({ host: "db.example.com", port: "5432", connectTimeoutMs: "2000" }),
    );
    expect(present.host).toBe("db.example.com");
    expect(present.port).toBe("5432");
    expect(present.connectTimeoutMs).toBe("2000");

    const absent = tcpConfigFromForm(fd({ host: "db.example.com" }));
    expect(absent.port).toBeUndefined();
    expect(absent.connectTimeoutMs).toBeUndefined();
  });
});

describe("round-trip through CreateMonitorSchema (tcp branch)", () => {
  it("parses a form into a valid tcp config with the default timeout applied", () => {
    const form = fd({
      type: "tcp",
      name: "Database",
      intervalSeconds: "60",
      host: "db.example.com",
      port: "5432",
    });
    const parsed = CreateMonitorSchema.safeParse({
      type: formType(form),
      name: form.get("name"),
      intervalSeconds: form.get("intervalSeconds"),
      enabled: form.get("enabled") ?? "",
      config: tcpConfigFromForm(form),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "tcp") {
      const config = (parsed.data as CreateTcpMonitorInput).config;
      expect(config.host).toBe("db.example.com");
      expect(config.port).toBe(5432);
      // numeric default applies when the field was absent
      expect(config.connectTimeoutMs).toBe(5000);
    }
  });

  it("rejects a tcp form whose host is internal (SSRF guard at the boundary)", () => {
    const form = fd({
      type: "tcp",
      name: "Internal",
      intervalSeconds: "60",
      host: "169.254.169.254",
      port: "80",
    });
    const parsed = CreateMonitorSchema.safeParse({
      type: formType(form),
      name: form.get("name"),
      intervalSeconds: form.get("intervalSeconds"),
      enabled: form.get("enabled") ?? "",
      config: tcpConfigFromForm(form),
    });
    expect(parsed.success).toBe(false);
  });
});

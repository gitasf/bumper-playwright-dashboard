import type { Context } from "hono";

/** Read a string field from FormData. Files and missing fields return "". */
export function readField(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

/**
 * Read a single string field from a request body that may arrive as either
 * `application/json` (the client-driven path) or `FormData` (the no-JS slow
 * path that POSTs a plain `<form>`). Sniffs `content-type`; on JSON it reads
 * `json[jsonKey]`, otherwise `formData[formKey]`. Non-string values and missing
 * fields collapse to `""`; the result is trimmed.
 *
 * This confines the one genuinely-fiddly part — the unsafe cast on the JSON
 * branch plus the typeof-string guard — to a single place. Malformed JSON is
 * deliberately NOT caught: `c.req.json()` throws, and that throw is allowed to
 * propagate to `middleware/00.errors.ts` exactly as the inlined handlers did.
 */
export async function readBodyField(
  c: Context,
  { jsonKey, formKey }: { jsonKey: string; formKey: string },
): Promise<string> {
  const ctype = c.req.header("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await c.req.json()) as Record<string, unknown>;
    const value = body[jsonKey];
    return typeof value === "string" ? value.trim() : "";
  }
  const form = await c.req.formData();
  return readField(form, formKey).trim();
}

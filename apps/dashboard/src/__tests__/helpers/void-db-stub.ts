/**
 * Test-only stand-in for `void/db`. Under vitest the void plugin is disabled
 * (it tries to bootstrap D1 migrations and wrap workers), so the virtual
 * `void/db` module isn't resolved. Pure-function tests don't actually exercise
 * any operator — they only need the module imports to load. So we export
 * identity-style placeholders for each named export.
 *
 * DB-touching tests should `vi.mock("void/db", ...)` with real Drizzle
 * bindings rather than relying on this stub.
 */

function placeholder(name: string) {
  return (...args: unknown[]) => ({ __op: name, args });
}

export const and = placeholder("and");
export const asc = placeholder("asc");
export const avg = placeholder("avg");
export const between = placeholder("between");
export const count = placeholder("count");
export const desc = placeholder("desc");
export const eq = placeholder("eq");
export const exists = placeholder("exists");
export const gt = placeholder("gt");
export const gte = placeholder("gte");
export const ilike = placeholder("ilike");
export const inArray = placeholder("inArray");
export const isNotNull = placeholder("isNotNull");
export const isNull = placeholder("isNull");
export const like = placeholder("like");
export const lt = placeholder("lt");
export const lte = placeholder("lte");
export const max = placeholder("max");
export const min = placeholder("min");
export const ne = placeholder("ne");
export const not = placeholder("not");
export const notBetween = placeholder("notBetween");
export const notExists = placeholder("notExists");
export const notInArray = placeholder("notInArray");
export const notLike = placeholder("notLike");
export const or = placeholder("or");
export const sum = placeholder("sum");

// `sql` is used both as a function and as a tagged template — handle both.
// `.mapWith(decoder)` is Drizzle's result-decoder hook (used by `numericSql`);
// the stub records it as a no-op returning the same node so a fragment built in
// a pure-function test (e.g. `numericSql(sql\`count(*)\`)`) doesn't throw.
function sqlImpl(strings: TemplateStringsArray | string, ...args: unknown[]) {
  const node = {
    __op: "sql",
    strings,
    args,
    mapWith(_decoder: unknown) {
      return node;
    },
  };
  return node;
}
(sqlImpl as unknown as { raw: typeof sqlImpl }).raw = sqlImpl;
function joinImpl(chunks: unknown[], separator?: unknown) {
  return { __op: "sql.join", chunks, separator };
}
(sqlImpl as unknown as { join: typeof joinImpl }).join = joinImpl;
export const sql = sqlImpl as unknown as {
  (strings: TemplateStringsArray, ...args: unknown[]): unknown;
  (raw: string): unknown;
  raw: typeof sqlImpl;
  join: typeof joinImpl;
};

export const db = new Proxy(
  {},
  {
    get(_target, prop: string | symbol) {
      throw new Error(
        `void/db.db.${String(prop)} was accessed in a unit test that doesn't mock it. ` +
          "Pure-function tests must not exercise the database; for DB-touching " +
          "tests, use vi.mock('void/db', ...) with a real Drizzle binding.",
      );
    },
  },
);

export function createDb(): never {
  throw new Error("createDb is not available in the void/db stub");
}

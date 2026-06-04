// Canned catalog for the local seed script: spec files + test titles, actors,
// branch name templates, commit messages. Shaped to look like an e-commerce
// test suite so the UI shows recognisable-looking data.
//
// Also the single home for the synthetic-data primitives (the seeded PRNG and
// the deterministic fake-SHA derived from it). Both the history generator and
// the upload-fixtures volume scenarios need a "fake but stable commit SHA";
// keeping `makePrng` + `sha40` here means that concept lives in one place
// instead of being re-derived per entrypoint with a divergent algorithm.

/**
 * xorshift32. Deterministic, 1 line of state, zero deps. Good enough for
 * seeding — we're not doing crypto or serious Monte Carlo.
 *
 * @param {string} seedString
 * @returns {() => number} a PRNG returning [0, 1)
 */
export function makePrng(seedString) {
  let state = 0x811c9dc5;
  for (let i = 0; i < seedString.length; i++) {
    state = Math.imul(state ^ seedString.charCodeAt(i), 0x01000193) >>> 0;
  }
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * A deterministic 40-char lowercase-hex commit SHA, drawn from a PRNG. Both
 * the history generator (per-run `commitSha`) and the upload-fixtures volume
 * scenarios use this so their fake SHAs come from one algorithm; callers that
 * need a stable per-index SHA seed a PRNG via `makePrng(String(n))`.
 *
 * @param {() => number} rand — seeded PRNG returning [0, 1)
 * @returns {string} 40 lowercase hex chars
 */
export function sha40(rand) {
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = Math.floor(rand() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const SPEC_FILES = [
  {
    file: "tests/auth/signin.spec.ts",
    titles: [
      "signs in with password",
      "rejects wrong password",
      "rate-limits repeated failures",
      "redirects authed users from /signin",
      "remembers session across reload",
    ],
  },
  {
    file: "tests/auth/signup.spec.ts",
    titles: [
      "creates a new account",
      "validates email format",
      "enforces password strength",
      "requires email verification",
    ],
  },
  {
    file: "tests/auth/reset-password.spec.ts",
    titles: [
      "sends reset email",
      "accepts valid token",
      "rejects expired token",
    ],
  },
  {
    file: "tests/checkout/cart.spec.ts",
    titles: [
      "adds item to cart",
      "updates quantity",
      "removes item",
      "persists cart across reload",
      "merges guest cart on signin",
    ],
  },
  {
    file: "tests/checkout/payment.spec.ts",
    titles: [
      "charges a valid card",
      "declines invalid card",
      "shows 3ds challenge",
      "retries on network blip",
      "stores card for next time",
    ],
  },
  {
    file: "tests/checkout/shipping.spec.ts",
    titles: [
      "calculates shipping by zip",
      "applies free shipping threshold",
      "validates address",
    ],
  },
  {
    file: "tests/checkout/discount.spec.ts",
    titles: [
      "applies valid code",
      "rejects expired code",
      "stacks allowed combinations",
      "hides invalid code in UI",
    ],
  },
  {
    file: "tests/search/search.spec.ts",
    titles: [
      "returns results for common query",
      "handles empty results",
      "paginates beyond 20 items",
      "highlights matches",
      "suggests corrections",
    ],
  },
  {
    file: "tests/search/filters.spec.ts",
    titles: [
      "filters by category",
      "filters by price range",
      "clears all filters",
      "preserves filters on pagination",
    ],
  },
  {
    file: "tests/product/detail.spec.ts",
    titles: [
      "renders image gallery",
      "swaps variants",
      "shows out-of-stock",
      "loads reviews",
      "displays related products",
    ],
  },
  {
    file: "tests/account/profile.spec.ts",
    titles: [
      "updates display name",
      "uploads avatar",
      "changes email with verification",
    ],
  },
  {
    file: "tests/account/orders.spec.ts",
    titles: ["lists past orders", "filters by date", "downloads invoice pdf"],
  },
  {
    file: "tests/admin/products.spec.ts",
    titles: [
      "creates a product",
      "edits price",
      "archives a product",
      "bulk imports from csv",
    ],
  },
  {
    file: "tests/admin/users.spec.ts",
    titles: ["searches users", "assigns roles", "suspends a user"],
  },
  {
    file: "tests/accessibility/landmarks.spec.ts",
    titles: [
      "homepage has a main landmark",
      "pages have unique h1",
      "dialogs trap focus",
      "skip-to-content link works",
    ],
  },
];

export const ACTORS = [
  "alex-rivera",
  "priya-shah",
  "jordan-li",
  "sam-okafor",
  "kai-nakamura",
];

// Branch name templates. `{n}` placeholder filled per-branch-lifecycle.
export const BRANCH_TEMPLATES = [
  "feat/{n}-refactor-cart",
  "feat/{n}-wishlist",
  "feat/{n}-payment-retry",
  "feat/{n}-search-v2",
  "feat/{n}-admin-bulk",
  "fix/{n}-signin-throttle",
  "fix/{n}-cart-race",
  "fix/{n}-3ds-redirect",
  "fix/{n}-checkout-timeout",
  "chore/{n}-bump-deps",
  "chore/{n}-lint-pass",
  "refactor/{n}-orders-module",
];

export const COMMIT_MESSAGES = [
  "wip",
  "address review comments",
  "fix flaky test",
  "refactor shared helpers",
  "add missing aria labels",
  "cover edge case in cart merge",
  "skip test on webkit (browser bug)",
  "bump playwright",
  "drop unused branch",
  "handle 429 from upstream",
  "use semantic colors",
  "inline the helper, extraction wasn't pulling its weight",
  "propagate abort signal",
  "guard against empty result set",
];

// ~5% of tests are chronically flaky, ~10% occasionally flaky, rest stable.
// Deterministic by testId so reruns with same seed produce same profile.
function stabilityFor(testId) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < testId.length; i++) {
    h = Math.imul(h ^ testId.charCodeAt(i), 16777619) >>> 0;
  }
  const bucket = h % 100;
  if (bucket < 5) return "chronic";
  if (bucket < 15) return "occasional";
  return "stable";
}

/**
 * Flatten SPEC_FILES into a list of tests with stability profile + a
 * birthday offset (0–90 days back from "now") so the suite visibly grows
 * over the history window rather than being frozen in size.
 *
 * @param {() => number} rand — seeded PRNG returning [0, 1)
 */
export function buildTestCatalog(rand) {
  const tests = [];
  for (const spec of SPEC_FILES) {
    for (const title of spec.titles) {
      const testId = `${spec.file}|${title}`;
      tests.push({
        testId,
        file: spec.file,
        title,
        stability: stabilityFor(testId),
        // Born some number of days before "now". Skew so most tests are
        // old (born >60 days ago), with a long tail of newer tests so the
        // total-tests count on old runs is smaller.
        birthDaysAgo: Math.floor(rand() ** 2 * 90),
      });
    }
  }
  return tests;
}

export function branchesForLifecycle(rand, n) {
  const template =
    BRANCH_TEMPLATES[Math.floor(rand() * BRANCH_TEMPLATES.length)];
  return template.replace("{n}", String(n));
}

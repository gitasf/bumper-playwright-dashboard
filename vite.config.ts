import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*.{js,jsx,ts,tsx,mjs,cjs}": "vp check --fix",
    "*.{json,jsonc,md,yaml,yml,css}": "vp fmt --write",
  },
  fmt: {
    ignorePatterns: ["**/worker-configuration.d.ts", "**/*.html"],
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    bracketSpacing: true,
    arrowParens: "always",
    endOfLine: "lf",
  },
  lint: {
    plugins: ["typescript", "import"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "no-await-in-loop": "off",
      "typescript/consistent-return": "off",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-explicit-any": "warn",
      "typescript/no-unused-vars": "error",
      "import/no-cycle": "error",
    },
    overrides: [
      {
        files: ["apps/dashboard/**/*.{tsx,jsx}"],
        plugins: ["typescript", "import", "react"],
      },
      {
        files: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.spec.ts",
          "**/__tests__/**",
          "**/__integration__/**",
        ],
        rules: {
          "typescript/no-explicit-any": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
    ],
    ignorePatterns: ["dist", "coverage", ".wrangler", "*.d.ts"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});

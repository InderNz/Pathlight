import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "Archive/**",
      "Docs/**",
      "apps/web/dist/**",
      "node_modules/**",
      "pathlight-spike/**",
      "pathlight-app/**",
      "playwright-report/**",
      "test-results/**",
      ".tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts", "e2e/**/*.ts", "*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);

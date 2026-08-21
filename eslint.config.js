import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src-tauri/target", "vendor"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json", "./tsconfig.e2e.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // An unawaited promise in an offline-first client is a silently dropped write.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Empty catch blocks are how "storage is unavailable" turns into "nothing saved
      // and nobody knows". Where we genuinely mean it, the comment says why.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // Node built-ins have no business in code that ships to a browser or a Tauri
      // webview. They are legitimate in the test helpers, which run under Node — that
      // exception is granted explicitly below rather than by everyone remembering.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "path", "crypto", "vm", "child_process"],
              message:
                "Node built-ins do not exist in the browser or in a Tauri webview. If this is test-only code, put it in src/test/.",
            },
          ],
        },
      ],

      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Test helpers run under Node, so they may use its built-ins.
    files: ["src/test/**", "**/*.node.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Node-side config files.
    files: ["vite.config.ts", "eslint.config.js", "playwright.config.ts", "e2e/**", "tooling/**"],
    languageOptions: { globals: globals.node },
    // These run under Node by definition; they are never bundled into the app.
    rules: { "no-restricted-imports": "off" },
  },
);

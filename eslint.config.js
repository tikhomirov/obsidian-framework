// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "packages/plugin/main.js", "eslint.config.js", "packages/plugin/esbuild.config.mjs", "packages/worker/bundle.mjs", "packages/worker/dist-bundle/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["vitest.config.ts"], defaultProject: "tsconfig.base.json" }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: false }],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:fs", "node:fs/promises", "fs", "fs/promises"], message: "Vault I/O only via packages/server/src/vault (single write layer)." }] },
      ],
    },
  },
  {
    files: ["packages/server/src/vault/**", "packages/server/src/fsutil.ts", "packages/worker/src/**", "packages/*/test/**", "packages/server/src/config.ts", "packages/server/src/git.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["packages/*/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);

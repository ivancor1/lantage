import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python virtualenvs. `services/inference/.venv` contains torch, which ships
    // bundled JS (torch/utils/model_dump/code.js) that ESLint otherwise lints
    // and fails on — third-party vendored code we neither own nor edit.
    "**/.venv/**",
    // Locally cached model weights and hub checkouts.
    ".lantage-models/**",
  ]),
]);

export default eslintConfig;

import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            ".next/**",
            ".qa/**",
            ".tmp-*.mjs",
            ".tmp-ui/**",
            "build/**",
            "coverage/**",
            "dist/**",
            "node_modules/**",
            "out/**",
            "public/**",
            "vendor/**",
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: { globals: globals.browser },
        plugins: { "react-hooks": reactHooks },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "react-hooks/exhaustive-deps": "warn",
            "react-hooks/rules-of-hooks": "error",
        },
    },
    {
        files: ["*.config.{js,mjs,mts,ts}", "scripts/**/*.{js,mjs,ts}"],
        languageOptions: { globals: globals.node },
    },
);

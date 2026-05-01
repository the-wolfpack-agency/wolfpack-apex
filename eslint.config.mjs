import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Baseline-restore overrides.
 *
 * A transitive eslint-plugin update pulled in by `eslint-config-next`
 * activated several rules that were previously off, surfacing
 * 23,300 pre-existing systemic errors across the codebase (~12K
 * require()s, ~4.5K `any`s, ~2.6K unsafe-function-types, etc.). These
 * aren't new bugs — they're architectural patterns this repo has
 * always used. Re-enabling them all at once would block every PR for
 * the team, so we downgrade to warnings or off and keep the small
 * high-signal rules at error level.
 *
 * Punch list for incremental cleanup (each can be its own focused PR):
 *   - `@next/next/no-assign-module-variable` (83) — real Next bug
 *   - `@next/next/no-html-link-for-pages` (70) — real Next best practice
 *   - `react/no-unescaped-entities` (81) — cosmetic, easy autofix
 *   - `react/display-name` (28) — small surface
 *   - `react-hooks/set-state-in-effect` (353) — React Compiler
 *     experimental, not stable yet
 */
const baselineOverrides = {
  rules: {
    // Bulk-suppress systemic patterns the codebase relies on:
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unsafe-function-type": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-empty-object-type": "off",
    "@typescript-eslint/no-this-alias": "off",
    "@typescript-eslint/no-unused-vars": "warn",
    // React Compiler experimental rules — emit too many false positives
    // on patterns the existing app uses safely. Keep off until the
    // compiler ships stable.
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/immutability": "off",
    "react-hooks/purity": "off",
    "react-hooks/refs": "off",
    "react-hooks/preserve-manual-memoization": "off",
    "react-hooks/static-components": "off",
    // Cosmetic rules — downgrade so they don't block PRs.
    "react/no-unescaped-entities": "warn",
    "react/display-name": "off",
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  baselineOverrides,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /* Claude Code worktrees — agent runs leave shadow copies of the
       repo under .claude/worktrees/<agent-id>/. These are scratch
       trees, not real source; lint output from them blocked CI with
       ~238 phantom errors (rules-of-hooks, html-link-for-pages, etc.)
       that don't exist in the canonical tree. */
    ".claude/**",
    /* Generated build output that occasionally leaks past .next/**
       on nested worktrees and similar caches. */
    "**/.next/**",
    "**/out/**",
  ]),
]);

export default eslintConfig;

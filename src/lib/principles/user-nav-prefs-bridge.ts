/**
 * No-op shim. The customizable-nav lib (`src/lib/user-nav-prefs.ts`)
 * keeps a `KNOWN_NAV_HREFS` allow-list that's contract-tested against
 * the live NAV_ITEMS in (dashboard)/layout.tsx. Adding `/principles`
 * to the layout requires the same href to appear in the allow-list,
 * otherwise the contract test in
 * `src/lib/__tests__/user-nav-prefs.test.ts` ("matches the NAV_ITEMS
 * array in (dashboard)/layout.tsx") fails CI.
 *
 * This file exists only to surface that dependency to anyone reading
 * the principles lib for the first time. The real list update lives
 * in `src/lib/user-nav-prefs.ts`.
 */
export {};

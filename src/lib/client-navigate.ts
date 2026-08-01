/**
 * Full-page navigation, as a module so it can be mocked.
 *
 * Sign-in and sign-out change the auth cookies. A soft router navigation
 * reuses the router cache and RSC payloads that were fetched before those
 * cookies existed, so the destination can render against the session the user
 * just replaced. A full load makes the browser send the new cookies on a fresh
 * document request.
 *
 * It lives here rather than inline because jsdom makes `window.location`
 * read-only, so a component that calls it directly cannot be tested without
 * fighting the environment. One indirection buys an assertion.
 */
export function hardNavigate(path: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(path);
}

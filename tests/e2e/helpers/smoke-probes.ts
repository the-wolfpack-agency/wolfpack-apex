/**
 * What the verify smoke probes, in one place, so the suite that runs against
 * production and the guardrail that runs on every pull request are reading the
 * same list. They were not, and could not be: the guardrail did not exist.
 *
 * Every expectation here has to be text that ONLY a rendered page has. The
 * boot splash says "Loading Instinct…", so any probe expecting a fragment of
 * that passes on a blank screen. Two of them did, from 2026-06-28 to
 * 2026-08-24. `probe-expectations-are-real` in smoke-probe-waits.spec.ts is
 * what keeps that from returning.
 */
import type { SmokeProbe } from "./smoke-helpers";

// Routes per the verify spec. Authenticated routes expect text found in the
// signed-in dashboard shell; the landing route works unauthenticated.
export const PROBES: SmokeProbe[] = [
  // NOT "Instinct". That fragment is inside the boot splash ("Loading
  // Instinct…"), so this probe passed on a blank screen for two months. The
  // sidebar wordmark says "Instinct" too, which is exactly the problem: the
  // expectation could not tell a rendered shell from an unrendered one.
  { path: "/", expectText: "Dashboard" },
  // /setup shows the wizard ("Set up your workspace") for a fresh workspace but
  // redirects an already-onboarded account (e.g. the smoke user) to the
  // dashboard shell. Accept either; a 401 blank is the real failure we guard.
  // The old "Setup" probe never matched the "Set up" h1 and was hidden by
  // verify.yml continue-on-error. The dashboard-shell fallback is the "Dashboard"
  // nav item rather than the "Instinct" wordmark, for the reason given above.
  { path: "/setup", expectText: "Set up", expectAnyText: ["Set up", "Dashboard"] },
  { path: "/tasks", expectText: "Task" },
  { path: "/releases", expectText: "Releases" },
  { path: "/products", expectText: "Products" },
  { path: "/engineering", expectText: "Engineering" },
  { path: "/notifications", expectText: "Notification" },
  { path: "/settings", expectText: "Setting" },
  { path: "/admin/audit", expectText: "Audit" },
  { path: "/security-posture", expectText: "Security" },
];

// Routes that only work pre-auth (login itself). Keep the landing / root probe
// above, it is expected to render without a session.
export const PUBLIC_PATHS = new Set<string>(["/"]);

/** Signed out, / resolves to the sign-in screen. Shared with the guardrail so
 *  the public probe is held to the same standard as the authenticated ones. */
export const PUBLIC_LANDING_PROBE: SmokeProbe = { path: "/", expectText: "Sign In" };

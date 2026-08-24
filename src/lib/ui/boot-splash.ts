/**
 * The dashboard shell's boot splash, named in one place.
 *
 * WHY A CONSTANT FOR ONE STRING
 *
 * On 2026-08-24 the verify smoke was found asserting page text against this
 * splash rather than against any page. It reads the body the instant the
 * document fires domcontentloaded, and at that moment every authenticated
 * route in this app says exactly one thing: "Loading Instinct…".
 *
 * Two of the ten probes expected the fragment "Instinct", which the splash
 * contains, so those two passed no matter what the page did. The first probe
 * that asked for something the splash does not say, /tasks, failed. It had
 * been failing on main since 2026-06-28 while the product was healthy the
 * whole time.
 *
 * So the splash copy and its test id live here, imported by the shell that
 * renders it and by the guardrail that checks no probe can be satisfied by
 * it. A probe expectation and the loading screen can no longer overlap
 * without a test saying so.
 */

/** Test id on the splash, so tests wait for it by identity rather than copy. */
export const BOOT_SPLASH_TESTID = "app-boot-splash";

/** What the shell shows before the session resolves. */
export const BOOT_SPLASH_TEXT = "Loading Instinct…";

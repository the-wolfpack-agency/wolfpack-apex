/**
 * What the signed-in person may do, on the client.
 *
 * WHY THIS EXISTS AS ITS OWN THING
 *
 * Twice in two days a component was found asking the server for something the
 * viewer could not have: the dashboard's release-gate banner, then the
 * financials card. Both handled the refusal correctly and rendered nothing, so
 * nothing looked broken. Both were still wrong.
 *
 * The pattern is the same each time. A component discovers its own audience
 * from a 403, which means it asks EVERYBODY, which means most sessions produce
 * a refused request. The cost is invisible until you count it: a log full of
 * expected refusals, and a production assertion that no page fires a 401 or 403
 * that everybody learns to ignore because it is always red.
 *
 * The fix each time was one line, and the reason it kept happening is that the
 * line was not obvious. Reading a role out of localStorage and hand-checking it
 * against a capability list is enough friction that "just fetch and handle the
 * 403" wins. So it is one call now.
 *
 * THIS DECIDES WHAT TO ASK FOR, NEVER WHAT IS ALLOWED. The server enforces
 * every one of these capabilities on its own, from the same map. Nothing here
 * is a security control: a person editing localStorage grants themselves a
 * request that is then refused exactly as it is today. What it buys is a
 * product that does not ask questions it knows the answer to.
 */
import type { Capability } from "@/lib/auth/capabilities";
import { capabilitiesForRole } from "@/lib/auth/role-capabilities";
import { getInstinctUser } from "@/lib/client-auth";

/**
 * May the signed-in person do this?
 *
 * False when nobody is signed in, which is the right answer: a component
 * rendering before a session exists should ask for nothing.
 */
export function canI(capability: Capability): boolean {
  const role = getInstinctUser<{ role?: string }>()?.role;
  if (!role) return false;
  return capabilitiesForRole(role).has(capability);
}

/** True when the person holds every one of these. */
export function canIAll(...capabilities: Capability[]): boolean {
  return capabilities.every((c) => canI(c));
}

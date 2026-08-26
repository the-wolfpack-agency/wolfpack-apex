/**
 * What a client-facing role is actually allowed to reach.
 *
 * WHY THE ROLE GATE DOES NOT DO THIS. A tool declares a minimum role and the
 * gate compares ranks, which works when tools disagree about who may call
 * them. Forty-six of the sixty declare "*", meaning anyone, so the comparison
 * has nothing to compare: measured on 2026-08-26 every role from cto to viewer
 * could invoke fifty-eight of sixty tools. Scoping by role was a claim about a
 * mechanism that was not being used.
 *
 * Rewriting forty-six capability declarations before a pilot is the wrong way
 * to fix that. It touches every tool, risks removing access an internal user
 * relies on today, and cannot be reviewed properly in the time available. It
 * also solves a different problem: whether a tool is SENSITIVE, rather than
 * whether it is any of this person's business.
 *
 * A persona is the second question, and it is the one a dealer's assistant
 * needs. A dealer does not need the financials tools withheld on security
 * grounds; they need them absent, because a menu of fifty-eight capabilities
 * where six are theirs is not a product they can use, and every irrelevant
 * tool is one more thing a phrase can be matched against wrongly.
 *
 * ADDITIVE BY DESIGN. A role with no persona behaves exactly as it does today.
 * This can be switched on for one client-facing role without moving anything
 * for anybody else, which is the only kind of change worth making this close to
 * a deployment.
 */

/**
 * Tools a persona may reach, by name.
 *
 * Named explicitly rather than derived from a pattern. A rule like "everything
 * matching vehicle" quietly grants the next tool somebody names that way, and
 * the whole point is that this list is the thing a person reviewed.
 */
export const TOOL_PERSONAS: Record<string, readonly string[]> = {
  /* A Porsche Center's own staff: their cars, their guests, their week, and
     the documents their Center is allowed to read. Nothing about anybody
     else's Center, and nothing about the agency running the programme. */
  dealer: [
    "what_can_you_do",
    "get_calendar_availability",
    "calendar_widget",
    "dms_inventory_widget",
    /* The universal search, which fans out to the document library. */
    "search",
    "feedback",
  ],
  /* A Center manager adds the people and the numbers for their own Center. */
  dealer_manager: [
    "what_can_you_do",
    "get_calendar_availability",
    "calendar_widget",
    "dms_inventory_widget",
    /* The universal search, which fans out to the document library. */
    "search",
    "feedback",
    "meeting_prep",
    "who_is",
    "search_mail",
    "plan_my_day",
  ],
};

/** True when this role's surface is curated rather than rank-based. */
export function hasPersona(role: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_PERSONAS, (role ?? "").toLowerCase());
}

/**
 * May this persona reach this tool?
 *
 * Fails closed for a persona: a tool that is not on the list is not reachable,
 * including one added tomorrow. That is deliberate. A curated surface that
 * silently grows whenever somebody registers a tool is not curated, and the
 * cost of the alternative is that adding a dealer capability means naming it
 * here, which is a review rather than an accident.
 */
export function personaAllows(role: string, toolName: string): boolean {
  const allowed = TOOL_PERSONAS[(role ?? "").toLowerCase()];
  if (!allowed) return true;
  return allowed.includes(toolName);
}

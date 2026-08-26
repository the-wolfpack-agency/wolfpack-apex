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


/**
 * What a tool is called, and what it does, in the reader's language.
 *
 * WHY THIS IS SEPARATE FROM ToolDef.description. That field is read by the
 * dispatcher, the agent scan and the registry docs, and it is written for
 * whoever maintains the tool: "Drive the dealer's DMS web UI (via the
 * AgenticQA browser-driver bridge) to fetch and render vehicle inventory
 * matching the user's filters."
 *
 * That is the most important capability a dealer has, and it was the first
 * thing they read about it. Every word is about our architecture. A person
 * deciding whether this product is worth their time learns that it is not for
 * them, and they are right to.
 *
 * Only the handful of tools a persona exposes need this, which is why it is a
 * small map rather than a field on sixty tools. A tool with no entry falls back
 * to its own description, so nothing is hidden by omission.
 */
export interface PersonaCopy {
  /** The section it belongs under, in the reader's terms. */
  area: string;
  /** One line, second person, saying what they get rather than how it works. */
  description: string;
}

export const PERSONA_COPY: Record<string, PersonaCopy> = {
  dms_inventory_widget: {
    area: "Your demo vehicles",
    description: "See which cars are registered, which are free, and which are out with a guest",
  },
  calendar_widget: {
    area: "Your week",
    description: "See the month at a glance, with everything that is booked",
  },
  get_calendar_availability: {
    area: "Your week",
    description: "Check whether you or a colleague are free at a particular time",
  },
  search: {
    area: "Your documents",
    description: "Search the programme documents, your mail and your calendar in one go",
  },
  feedback: {
    area: "Telling us something",
    description: "Report a problem or send a note to the team, with a screenshot if it helps",
  },
  meeting_prep: {
    area: "Your week",
    description: "A brief for your next meeting, with what is worth reading first",
  },
  who_is: {
    area: "People",
    description: "Look somebody up before you speak to them",
  },
  search_mail: {
    area: "Your mail",
    description: "Find an email by who sent it or what it was about",
  },
  plan_my_day: {
    area: "Your week",
    description: "Describe your day and get back what can be done for you",
  },
};

/** Copy for a tool when the reader has a persona, or null to use its own. */
export function personaCopyFor(role: string, toolName: string): PersonaCopy | null {
  if (!hasPersona(role)) return null;
  return PERSONA_COPY[toolName] ?? null;
}

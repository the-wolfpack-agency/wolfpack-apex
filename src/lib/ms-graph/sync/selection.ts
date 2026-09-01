/**
 * Which Microsoft entities this deployment syncs, and why it is a choice.
 *
 * WHAT WAS FOUND. The whole sync layer exists: a dispatcher and five workers
 * for calendar, tasks, mail, contacts and files, each draining a Graph delta
 * feed into a canonical table, each handling scope_missing and rate limits
 * without throwing. All of it correct, tested, and called by nothing.
 *
 * The consequence was measured on 2026-08-31: every one of those tables holds
 * zero rows, instinct_ms_sync_state holds a single cursor for directory_users,
 * and eleven learning extractors read empty tables and produce nothing.
 *
 * CACHING SOMEBODY'S MAILBOX IS A DECISION, NOT A DEFAULT. The syncs are
 * enabled one at a time by configuration, because "what do we keep, for how
 * long, and who can read it" is a question with an owner, and switching all
 * five on because they happened to be written would answer it by accident.
 *
 * CALENDAR IS ON BY DEFAULT AND THE OTHERS ARE NOT. A calendar holds who met
 * whom and when, which is the least sensitive of the five and the one whose
 * absence currently costs the most: the most frequent unanswered questions on
 * this deployment are all about meetings, and the "how is a week actually
 * spent" signal cannot run without it. Mail, contacts and files stay off until
 * somebody decides they should be on.
 */

import type { MsEntityType } from "./common";

/** Entity types this deployment will sync unless configuration says otherwise. */
export const DEFAULT_ENTITIES: MsEntityType[] = ["events"];

/** Everything a worker exists for, so the report can name what is switched off. */
export const ALL_ENTITIES: MsEntityType[] = ["events", "tasks", "messages", "contacts", "files"];

/**
 * Read the selection from configuration.
 *
 * MS_SYNC_ENTITIES is a comma-separated list. An empty or unset value means
 * the default, and an explicit "none" switches the whole thing off, which is
 * the setting somebody needs on a client deployment that has not decided yet.
 */
export function selectedEntities(
  raw: string | undefined = process.env.MS_SYNC_ENTITIES,
): MsEntityType[] {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return [...DEFAULT_ENTITIES];
  if (value === "none") return [];

  const asked = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  /* Unknown names are DROPPED rather than throwing. A typo in an environment
     variable must not stop the syncs that were spelled correctly, and the
     report says what was selected so a missing one is visible. */
  return ALL_ENTITIES.filter((e) => asked.includes(e));
}

/** What is deliberately not being kept, for a report that says so. */
export function notSelected(selected: MsEntityType[]): MsEntityType[] {
  return ALL_ENTITIES.filter((e) => !selected.includes(e));
}

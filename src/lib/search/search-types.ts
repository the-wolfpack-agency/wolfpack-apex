/**
 * The search types, declared once.
 *
 * There were three copies of this list: the SearchType union in runSearch.ts,
 * the SEARCH_TYPE_VALUES array that builds the zod schema in the search tool,
 * and a restated literal union on the widget result. Adding the Brain provider
 * meant editing all three, and nothing would have failed if one had been
 * missed: the widget would simply have refused to render document results,
 * which reads as "search found nothing" rather than as a type error.
 *
 * That is the same shape as the message-source drift, where a TypeScript union
 * and a database constraint were two lists nothing compared, and every Brain
 * answer failed to save for a month.
 *
 * So: one runtime array, and the type derived from it. A new provider adds its
 * value here and the union, the schema and the widget all follow.
 *
 * DELIBERATELY IMPORTS NOTHING. This is reachable from widget types, which
 * client components import, and a value import that drags the search engine
 * behind it is how server-only code ends up in a browser bundle.
 */

export const SEARCH_TYPE_VALUES = [
  "chat",
  "channel",
  "email",
  "calendar",
  "knowledge",
  "brain",
  "crm",
  "dms",
  "vercel",
  /* SharePoint searched in place, with the reader's own token, rather than our
     ingested copy of it. Sits alongside "brain" rather than replacing it: one
     finds the file, the other answers what is inside it. */
  "sharepoint",
] as const;

export type SearchType = (typeof SEARCH_TYPE_VALUES)[number];

/**
 * Universal Search provider registry.
 *
 * Order matters for the interleave fairness pass: the engine merges
 * by alternating providers, so the first provider in the list claims
 * slot 0, the second slot 1, etc. The chat/channel/email ordering
 * matches the pre-registry behavior so existing tests stay green.
 *
 * Adding a new tool that exposes searchable data? Append its provider
 * to this list AND export `searchProvider` from the tool module. The
 * `provider-coverage` guardrail test enforces both halves.
 */

import { chatsProvider } from "./chats";
import { channelsProvider } from "./channels";
import { emailsProvider } from "./emails";
import { calendarProvider } from "./calendar";
import { knowledgeProvider } from "./knowledge";
import { crmProvider } from "./crm";
import { dmsProvider } from "./dms";
import { vercelProvider } from "./vercel";
import { brainProvider } from "./brain";
import type { SearchProvider } from "./types";

export const SEARCH_PROVIDERS: SearchProvider[] = [
  chatsProvider,
  emailsProvider,
  calendarProvider,
  channelsProvider,
  knowledgeProvider,
  /* After curated knowledge, before the connectors. A hand-written answer
     should still outrank a document chunk in the interleave, but the corpus
     is the largest thing search can see and it belongs above the systems that
     usually return nothing. */
  brainProvider,
  crmProvider,
  dmsProvider,
  vercelProvider,
];

export type { SearchProvider, RunSearchContext } from "./types";

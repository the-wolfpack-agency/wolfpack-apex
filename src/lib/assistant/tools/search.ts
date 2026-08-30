/**
 * search tool — Universal Search inside the assistant.
 *
 * Returns IDENTICAL results to the /search page by delegating to the
 * shared `runSearch()` engine. The chat surface gets a one-line
 * summary ("Found 12 results for …: 4 chats, 0 channels, …, 2 CRM
 * records") plus citation-grade source refs so the user can click
 * straight through.
 *
 * Intent matching is intentionally NARROW: only the explicit verbs
 * "search" / "look up" / "find" / "show me", with an optional
 * "in <surface>" suffix. STRUCTURED CRM phrasings — typed-object
 * queries ("find the contact for Acme", "show me Acme's
 * opportunities", "deals over $50k") — still defer to the specialized
 * CRM tools because those have richer disambiguation surfaces.
 * BARE-search phrasings ("search Acme", "look up Acme") now flow
 * through Universal Search so the CRM provider fans in alongside
 * chats, emails, calendar, and knowledge — one query, all surfaces.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import {
  runSearch,
  type RunSearchParams,
  type SearchResponse,
  type SearchType,
} from "@/lib/search/runSearch";
import { getExternalRecordTool } from "./get-external-record-tool";
import { getRelatedRecordsTool } from "./get-related-records-tool";
import { filterExternalRecordsTool } from "./filter-external-records-tool";
import { scanInvoiceTool } from "./scan-invoice";
import { scanReceiptTool } from "./scan-receipt";
import { scanHrDocTool } from "./scan-hr-doc";
import { darkDataTool } from "./dark-data-tool";
import { registerTool } from "./registry";
import type { AssistantSourceRef } from "@/lib/assistant";
import type { ToolDef, ToolResult } from "./types";

import { SEARCH_TYPE_VALUES } from "@/lib/search/search-types";

const ParamSchema = z.object({
  query: z.string().min(1).max(200),
  types: z.array(z.enum(SEARCH_TYPE_VALUES)).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Params = z.infer<typeof ParamSchema>;

/* ---------------------------------------------------------------------
 * Intent matching
 *
 * Accepted phrasings (anchored ^/$, optional trailing punctuation):
 *   "search <query>"
 *   "search for <query>"
 *   "look up <query>"
 *   "find <query>"
 *   "show me <query>"
 * Optional "in (my )?(messages|emails|chats|calendar|knowledge|everywhere)"
 * suffix narrows to a single surface (chats and messages both → "chat";
 * "everywhere" → leave types undefined so all five are queried).
 *
 * Hard guard: any input claimed by a CRM connector tool returns null
 * here so the cascade falls through to the more-specific tool.
 * ------------------------------------------------------------------- */

const SURFACE_TO_TYPE: Record<string, SearchType | "all"> = {
  messages: "chat",
  message: "chat",
  chats: "chat",
  chat: "chat",
  emails: "email",
  email: "email",
  calendar: "calendar",
  knowledge: "knowledge",
  crm: "crm",
  salesforce: "crm",
  hubspot: "crm",
  dms: "dms",
  inventory: "dms",
  vehicles: "dms",
  everywhere: "all",
};

const INTENT_RE =
  /^\s*(?:search(?:\s+for)?|look\s+up|find|show\s+me)\s+(.+?)(?:\s+in\s+(?:my\s+)?(messages|message|chats|chat|emails|email|calendar|knowledge|crm|salesforce|hubspot|dms|inventory|vehicles|everywhere))?\s*[?.!]?\s*$/i;

/**
 * ASKING WHAT A DOCUMENT SAYS.
 *
 * "find the contract" reached this tool. "what does the SOW say" reached
 * NOTHING, and "summarize the SOW" reached op_create_document, which would
 * have tried to CREATE a document called the SOW rather than read the one
 * already in the library.
 *
 * That is the single most important sentence a SharePoint engagement has to
 * answer. A client connects a document library and then asks a question about
 * a document in it; the imperative "find X" is how an engineer phrases it and
 * "what does X say" is how everybody else does.
 *
 * The subject is captured and handed to the same universal search the
 * imperative form uses, so the Brain answers it with citations rather than a
 * model answering from whatever it had nearest.
 *
 * NOT ANCHORED ON A DOCUMENT NOUN, deliberately: a client says "the SOW", "the
 * contract", "the onboarding deck", "Jorge's proposal", and enumerating those
 * would be the same mistake as requiring the literal word "task" for a task.
 * The shape "what does <thing> say" is only ever a question about a document.
 */
const DOCUMENT_QUESTION_RE = new RegExp(
  [
    /* THESE TWO SURVIVE ONLY TO CATCH THE CONTAINER FORM.
     *
     * "what's in SharePoint about training" names the filing cabinet, and a
     * list is exactly the right answer. "what's in the contract" names a
     * document, and a list is exactly the wrong one. Both parse here; the
     * extractor below releases the second to retrieval and keeps the first. */
    String.raw`^ ?(?:what|whats|what's) (?:do(?:es)?|did) (?:the |our |my |this )?(?<saySubject>.+?) say(?: about (?<sayAbout>.+?))? ?[?.!]* ?$`,
    String.raw`^ ?(?:what|whats|what's) (?:is )?in (?:the |our |my |this )?(?<inSubject>.+?)(?: about (?<inAbout>.+?))? ?[?.!]* ?$`,
    /* "what is in the SharePoint about training". The article is optional so
       "what is in SharePoint about training" lands here too, and the topic is
       captured rather than swallowed into the subject. */

    /* SUMMARISE AND "WHAT DOES X SAY" ARE CONTENT QUESTIONS, NOT SEARCHES.
     *
     * Both used to be captured here and handed to universal search, which
     * returns a browsable LIST. Somebody who asks for a summary receives a
     * filing cabinet.
     *
     * THIS WAS TRIED ONCE AND REVERTED, AND THE REASON IT FAILED IS GONE.
     * On 2026-08-29 declining sent these to a model with no document context,
     * which then asked the reader to paste a document we already held. The
     * cause was retrieval, not routing: at the time the Brain could not find a
     * document by name at all.
     *
     * Since then filenames became searchable and weighted against semantic
     * scores. Measured on 2026-08-30, the same queries now retrieve:
     *
     *   "summarize the viaPeople work order"     5 hits, top 0.616, right doc
     *   "what does the onboarding document say"  5 hits, top 0.409
     *   "summarize the onboarding document"      2 hits, top 0.434
     *
     * All clear the 0.36 semantic floor, so retrieval has something to
     * synthesise from where before it had nothing.
     *
     * EXISTENCE QUESTIONS STAY BELOW. A list IS the right answer to "what
     * documents do we have about X", and moving those would break the one
     * thing search is genuinely best at. */
    /* DO WE HOLD ANYTHING ABOUT THIS. The question somebody asks before they
       trust the product with a real one, and it reached nothing.

       Measured 2026-08-28 against the deployed assistant: "what documents do
       we have about pcna" got "I don't have a confident answer for that",
       while the Brain held that client's entire SharePoint. "Do we have
       anything on the porsche program" was claimed by the verified-facts tool
       and answered "I don't have any verified facts about the porsche program
       yet", which reads as an empty product to somebody whose documents are
       all in there.

       Both are existence questions, and search is the only thing that can
       answer one honestly, because it is the only thing that can see
       everything. */
    String.raw`^ ?(?:what|which) (?:documents?|docs?|files?|records?|papers?) (?:do|does) (?:we|i|the team) have (?:on|about|for|regarding) (?<haveAbout>.+?) ?[?.!]* ?$`,
    String.raw`^ ?do (?:we|i) have (?:anything|any (?:documents?|docs?|files?|records?|info(?:rmation)?)) (?:on|about|for|regarding) (?<anythingAbout>.+?) ?[?.!]* ?$`,
    /* "is there anything on X", the same question phrased impersonally. */
    String.raw`^ ?is there (?:anything|any (?:documents?|docs?|files?|info(?:rmation)?)) (?:on|about|for|regarding) (?<thereAbout>.+?) ?[?.!]* ?$`,
    /* THE POLICY QUESTION. "find the pto policy" reached search and "whats our
       policy on pto" reached nothing, which is the wrong way round: the second
       is how anybody actually asks. An internal OS holding HR documents is
       asked this constantly, and it was answered by a model reading whatever
       it had nearest.

       Both orders, because people say "our policy on X" and "our X policy"
       interchangeably. The topic is the search term either way; "policy" is
       kept in the query because the document is usually called one. */
    String.raw`^ ?(?:what(?:'?s| is| are)?|where(?:'?s| is)?) (?:the |our |my )?polic(?:y|ies) (?:on|about|for|regarding) (?<policyOn>.+?) ?[?.!]* ?$`,
    String.raw`^ ?(?:what(?:'?s| is| are)?|where(?:'?s| is)?) (?:the |our |my )?(?<policyFor>.+?) polic(?:y|ies) ?[?.!]* ?$`,
  ].join("|"),
  "i",
);

/**
 * Words that name WHERE the documents are, not what they are about.
 *
 * THE BUG THIS FIXES. "what is in the SharePoint about training" captured
 * "SharePoint about training" as the thing to search for, and no document
 * contains the word SharePoint, so a question about a library we had fully
 * ingested returned "No results found". Measured 2026-08-27 against the real
 * pipeline: four similar phrasings returned documents and this one returned
 * nothing, purely because the sentence named the container.
 *
 * A client says "what's in SharePoint about X", "what's in our files about X",
 * "what's in the drive about X". They are naming the filing cabinet. The
 * search term is what follows "about".
 */
const CONTAINER_ONLY_RE =
  /^(?:share\s?point|one\s?drive|the\s+drive|drive|document\s+library|library|files|docs|documents|folder|folders|knowledge\s*base|brain|system|platform)$/i;

/**
 * Turn a document question into the same query the imperative form produces.
 *
 * "what does the SOW say about payment" searches for "SOW payment": the
 * subject plus what was asked about it, because a search for the subject alone
 * returns the whole document and buries the clause somebody wanted.
 */
export function matchDocumentQuestion(message: string): string | null {
  /* NORMALISED BEFORE MATCHING, WHICH IS A SECURITY PROPERTY.
   *
   * These patterns put `\s+` next to a lazy `.+?`, so both sides could match
   * the same space and a message of many spaces made the engine try every
   * split. Measured on 2026-08-30 against "what did " followed by N spaces:
   *
   *     n=200   10.4ms
   *     n=400   19.7ms
   *     n=800  112.0ms
   *     n=1600 858.8ms
   *
   * Superlinear, on a string a person can paste into the chat box, on a path
   * that runs before any authentication-independent rate limit. CodeQL flagged
   * the identical shape in brain/question-terms.ts (js/polynomial-redos) and
   * did NOT flag this file, which is the more useful half of the finding: the
   * scanner's silence was not evidence of safety.
   *
   * Collapsing whitespace first lets every pattern use a literal space, so the
   * ambiguity has nowhere to live. Same input, same matches, no backtracking. */
  const normalised = message.replace(/\s+/g, " ").trim();
  /* Bounded as defence in depth, so a future edit that reintroduces some other
     ambiguity cannot be exploited by length alone. No document question is
     this long. */
  if (normalised.length > 600) return null;
  const m = DOCUMENT_QUESTION_RE.exec(normalised);
  if (!m) return null;
  const g = (m.groups ?? {}) as Record<string, string | undefined>;

  /* The existence shapes carry their topic in a single group and have no
     subject to combine it with: "do we have anything on the porsche program"
     is asking about the topic, full stop. Handled before the subject/about
     pairing below rather than folded into it, because the container rule does
     not apply. Somebody asking "do we have anything on SharePoint" means the
     product, and searching for it is the right thing to do. */
  const existence = (g.haveAbout ?? g.anythingAbout ?? g.thereAbout ?? "").trim();
  if (existence) {
    if (/^(it|this|that|they|these|those)$/i.test(existence)) return null;
    return existence;
  }

  /* A policy question searches for the topic AND the word policy, because the
     document is nearly always called one and the topic alone returns every
     mention of it. */
  const policy = (g.policyOn ?? g.policyFor ?? "").trim();
  if (policy) {
    if (/^(it|this|that|they|these|those)$/i.test(policy)) return null;
    return `${policy} policy`;
  }

  const subject = (g.saySubject ?? g.inSubject ?? g.sumSubject ?? "").trim();
  if (!subject) return null;
  /* A pronoun carries no search terms, so it would return the library. */
  if (/^(it|this|that|they|these|those)$/i.test(subject)) return null;

  const about = (g.sayAbout ?? g.inAbout ?? "").trim();

  /* THE SUBJECT NAMES THE FILING CABINET, so the search term is the topic.
     Searching for the container returns nothing, because no document contains
     the word "SharePoint". */
  if (CONTAINER_ONLY_RE.test(subject)) {
    if (!about) {
      /* "what is in SharePoint", with nothing asked about. There is no query
         that answers this, and inventing one guarantees an empty result that
         reads as an empty library. Declining lets another tool try. */
      return null;
    }
    return about;
  }

  /* THE SUBJECT NAMES A DOCUMENT, so this is a content question and search is
     the wrong tool for it. Releasing it lets retrieval answer from the text.
     Everything above this line is a question about the LIBRARY, which is what
     search is genuinely best at; everything here is a question about a
     DOCUMENT, which only reading it can answer. */
  return null;
}

/* ---------------------------------------------------------------------
 * CRM-shadow guard — narrowed for Universal Search v2
 * ---------------------------------------------------------------------
 * v1 deferred to EVERY CRM-shaped phrasing, which meant "look up Acme"
 * and "search for Acme" never reached Universal Search even though the
 * user almost certainly wanted to fan out (CRM, chats, emails, …) at
 * once. v2 keeps the defer for the SPECIALIZED phrasings — typed
 * object queries, related-record queries, filter queries, ID lookups
 * — because those carry disambiguation context the CRM tools handle
 * better. Bare-search phrasings ("search Acme", "look up Acme") now
 * fall through so Universal Search wins and fans into CRM via the CRM
 * provider.
 *
 * Intents that STILL defer:
 *   - ID-shape lookups (claimed by get_external_record).
 *   - Typed-object: "find the contact for X" / "look up contact X" /
 *     "search for the account called X" (claimed by search_external_records).
 *   - Possessive related: "show me Acme's opportunities" / "Jorge's
 *     deals" (claimed by get_related_records).
 *   - Filter: "deals over $50k closing this month" / "stuck deals"
 *     (claimed by filter_external_records).
 *
 * Intents that USED TO defer and now flow through:
 *   - Generic verbs without a typed-object word: "look up Acme",
 *     "find Acme", "search for Acme".
 *   - Email-shape: "find grimace@x.com" (now searches all surfaces;
 *     a CRM contact match still surfaces via the CRM provider).
 * ------------------------------------------------------------------- */

/** Typed-object CRM phrasings. These have richer disambiguation
 *  (object-type aware result rendering) so the more specific tool
 *  should keep claiming them. Mirrors the typed-object PATTERN regex
 *  in search-external-records-tool.ts but only the typed arm. */
const TYPED_CRM_RE =
  /\b(?:look\s+up|find|search\s+for|fetch|pull|show\s+(?:me\s+)?(?:the\s+)?)(?:\s+the)?\s+(?:contacts?|people|person|deals?|opportunit(?:y|ies)|accounts?|compan(?:y|ies))(?:\s+(?:for|called|named|with\s+name))?\s+.{2,160}$/i;

/**
 * Does this tool claim the message, without letting a broken matcher decide
 * routing by accident?
 *
 * A throwing matcher must not take universal search down, which is why these
 * were wrapped. But swallowing it silently means a tool stops claiming its own
 * questions and nobody finds out: the message routes somewhere else and
 * answers plausibly from the wrong source, which is worse than an error
 * because it looks like a working product.
 *
 * Same protection, one line of evidence.
 */
function claims(name: string, match: (m: string) => unknown, message: string): boolean {
  try {
    return match(message) !== null;
  } catch (err) {
    console.warn(
      `[search] ${name}.matchIntent threw; it will not claim this message: ${(err as Error).message}`,
    );
    return false;
  }
}

function crmToolClaims(message: string): boolean {
  /* Typed-object CRM ("find the contact for Acme"). Same regex shape
   *  as PATTERNS[0] in search-external-records-tool. */
  if (TYPED_CRM_RE.test(message)) return true;
  /* Possessive related — "Acme's opportunities", "Jorge's open deals". */
  if (claims("getRelatedRecords", (m) => getRelatedRecordsTool.matchIntent(m), message)) return true;
  /* Filter — "deals over $50k closing this month". */
  if (claims("filterExternalRecords", (m) => filterExternalRecordsTool.matchIntent(m), message)) {
    return true;
  }
  /* ID-shape — "look up contact id 003abc". */
  if (claims("getExternalRecord", (m) => getExternalRecordTool.matchIntent(m), message)) return true;
  return false;
}

/**
 * Tools whose questions LOOK like document questions and are not.
 *
 * "what does this invoice say" is a scan of an attachment somebody just
 * dropped in, not a search of the library. "what is in the legacy database
 * that nobody uses" is a question about a SYSTEM, and dark_data answers it.
 * Both match the "what does X say" / "what is in X" shape exactly.
 *
 * Deferring to the specific tool rather than blacklisting words: a list of
 * banned nouns would need a new entry every time somebody phrases it
 * differently, and it would silently stop deferring the day one of these
 * tools widened its own matcher. Asking the tool is the only version that
 * stays true. Same approach as crmToolClaims above, for the same reason.
 */
function specificToolClaims(message: string): boolean {
  for (const t of [scanInvoiceTool, scanReceiptTool, scanHrDocTool, darkDataTool]) {
    try {
      if (t.matchIntent?.(message) != null) return true;
    } catch {
      /* A throwing matcher must not take universal search down with it. */
    }
  }
  return false;
}

/**
 * A single unfamiliar word, typed alone.
 *
 * "wolfpackxpcna" was typed 13 times in sixty days and answered nothing every
 * time. It is the name of the client's own SharePoint site. Somebody typing
 * only that is asking us to look it up, and the product's answer was "I don't
 * have a confident answer for that", thirteen times, to a person who was
 * telling us exactly what they wanted.
 *
 * WHY THIS IS NARROW AND STAYS NARROW. A rule that searched every bare word
 * would search "hello", "thanks" and "ok", which is a worse product than one
 * that says nothing. So it requires a single token of at least eight
 * characters with no spaces, which no greeting or acknowledgement reaches, and
 * an explicit list for the few long ones that exist. Names, site names, project
 * codes and file stems clear the bar; conversation does not.
 *
 * LAST RESORT BY CONSTRUCTION. Reached only after every other shape in this
 * file has declined, and search is the tool of last resort anyway: a miss
 * returns "no results for X", which is a true sentence somebody can act on,
 * and is what should have been said thirteen times.
 */
/**
 * Single words the product itself owns.
 *
 * "briefing" is eight characters, so it cleared the length bar and search
 * became a second claimant on a word the morning panel already answers.
 * Nobody typing one of these alone wants a document search; they want the
 * feature. Listed rather than inferred, because the alternative is asking
 * every tool whether it claims the message, and a search tool that consults
 * the whole registry to decide is the kind of coupling that makes a routing
 * change unpredictable.
 *
 * Only words of eight characters or more need to be here. Anything shorter
 * never reaches this check.
 */
const PRODUCT_NOUN_SINGLE_WORD =
  /^(?:briefing|calendar|dashboard|inventory|knowledge|integrations|settings|analytics|financials|documents|meetings|contacts|reminders|notifications)$/i;

const CONVERSATIONAL_SINGLE_WORD =
  /^(?:hello+|hey+|thanks?|thankyou|cheers|morning|afternoon|evening|goodbye|whatever|anything|everything|something|nothing|nevermind|understood|acknowledged|interesting|excellent|perfect|awesome|brilliant|continue|proceed|nonsense|seriously|honestly|obviously|apparently|basically|actually)$/i;

/**
 * A postal address, typed on its own.
 *
 * WHY IT BELONGS TO SEARCH. Somebody pasting an address is looking it up:
 * against a receipt, a venue, a client site, a contact record. Measured on a
 * real turn 2026-08-28, "69 West 43rd street New York, NY 10009" reached no
 * tool, went to a model, and came back "No results found... If this is a
 * search for a specific contact, record, or document, please clarify" for
 * 1,659 tokens and several seconds. The model was paid to say what the search
 * already knew.
 *
 * Measured across ninety days: 81 per cent of model answers with no grounding
 * at all say nothing useful. This does not act on that whole class, because
 * the remainder includes genuinely good conversational turns and one safety
 * response. It acts on the shape that is unambiguously a lookup.
 *
 * NARROW ON PURPOSE. Requires a leading house number, a street-type word, AND
 * either a postcode or a two-letter state. "43 things to do" and "10 Downing
 * Street is famous" do not match, because one has no street type and the other
 * has no number-leading start plus locality. A false positive here sends a
 * real question to search, which answers "no results" and is a worse product
 * than a model answering it well.
 */
const STREET_TYPE =
  /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy|highway|hwy|suite|ste)\b/i;
/**
 * US ZIP and ZIP+4, the two-letter-state-plus-ZIP form, and a UK postcode.
 *
 * The UK form was missing on the first pass and "221 Baker Street, London NW1
 * 6XE" fell through to a model. This engagement is US-centred, but an address
 * is an address and the pattern costs one alternation.
 */
const POSTAL_TAIL =
  /\b(?:\d{5}(?:-\d{4})?|[A-Z]{2}\s+\d{5}|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/;
const US_STATE = /,\s*(?:[A-Z]{2}|Alabama|Alaska|Arizona|California|Colorado|Florida|Georgia|Illinois|Michigan|New York|Ohio|Texas|Virginia|Washington)\b/i;

export function addressQuery(message: string): Params | null {
  const t = message.trim().replace(/[?.!]+$/, "");
  /* Must start with a house number: the single strongest signal that this is
     an address rather than a sentence mentioning a street. */
  if (!/^\d{1,6}\s+\S/.test(t)) return null;
  if (t.length < 12 || t.length > 160) return null;
  if (!STREET_TYPE.test(t)) return null;
  if (!POSTAL_TAIL.test(t) && !US_STATE.test(t)) return null;
  return { query: t };
}

export function bareIdentifierQuery(message: string): Params | null {
  const t = message.trim().replace(/[?.!,]+$/, "");
  /* One token. A space means it is a sentence, and sentences are handled by
     every shape above this one. */
  if (/\s/.test(t)) return null;
  if (t.length < 8 || t.length > 60) return null;
  /* Letters, digits and the separators that appear in site names and file
     stems. A token with punctuation beyond these is not something to search
     for. */
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(t)) return null;
  if (CONVERSATIONAL_SINGLE_WORD.test(t)) return null;
  if (PRODUCT_NOUN_SINGLE_WORD.test(t)) return null;
  /* AN OPAQUE RECORD ID IS NOT A SEARCH TERM.
     "003g500000GemUXAAZ" is a Salesforce id and belongs to get_external_record.
     The guard that already existed for this sits inside the "find X" branch
     and only covers 3 to 12 characters, so an 18-character id walked straight
     into this one: the first version of this function claimed it, and the
     search suite caught it.
     
     The tell is INTERLEAVING. An opaque id alternates digits and letters
     throughout ("003g500000GemUXAAZ", "a1b2c3d4e5f6g7"); a name written by a
     person puts its digits at the end if it has any ("porschecenter2026") or
     has a separator ("BA101_Day1", "20250814_FXa1584").

     Written first as "contains a digit at all", which rejected
     porschecenter2026: a perfectly ordinary site name, and exactly the kind of
     thing this function exists to look up. A digit followed by a letter is the
     narrower test and keeps it. */
  if (t.length >= 12 && !/[._-]/.test(t) && /\d[a-z]/i.test(t)) return null;
  /* An email address belongs to the CRM and people shapes, which run first;
     this is a backstop so a stray one never lands here. */
  if (t.includes("@")) return null;
  return { query: t };
}

/**
 * Strip instructions about the ANSWER'S SHAPE from the search query.
 *
 * Found by driving the deployed product as a user, 2026-08-29:
 *
 *   "summarize our SOW payment terms in two sentences"
 *     -> searched for "SOW payment terms in two sentences"
 *     -> Found 2 results ... Go to: Docs
 *
 * The same question without the instruction answers correctly from the document
 * with the figures and a citation. So the retrieval was never the problem: four
 * words about formatting were handed to the index as though they were subject
 * matter, and they match nothing, because no document is about being two
 * sentences long.
 *
 * Worse than a miss, it is a CONFIDENT miss. The reader asked for a summary and
 * got a result count, with no hint that their own words caused it.
 *
 * TRAILING ONLY, AND FROM A CLOSED LIST. A general "remove formatting words"
 * rule would eat real queries: "the two sentences clause", "brief for the
 * board", "short form agreement". These phrases only mean formatting when they
 * come last, after the thing being asked about, which is exactly where a person
 * puts them.
 */
const OUTPUT_INSTRUCTION_RE =
  /\s+(?:in|as|using)?\s*(?:a\s+|an\s+)?(?:short|brief|quick|plain|simple)?\s*(?:one|two|three|1|2|3|\d+)?\s*(?:sentences?|paragraphs?|bullets?|bullet\s+points?|lines?|words?|summary|list|english)\s*$/i;

/* "terms" was in that list for "in plain terms" and had to come out: it turned
   "SOW payment terms" into "SOW payment", mangling the exact query this
   product answers best. A rare phrasing is not worth breaking a common one,
   and the boundary test caught it before it shipped. */

/** Verbs that mean "give me a shorter version", which carry the same tail. */
const TRAILING_BREVITY_RE = /\s+(?:briefly|concisely|in\s+short|in\s+summary|tl;?dr)\s*$/i;

export function stripOutputInstruction(query: string): string {
  let out = query.trim();
  /* Twice: "summarize this briefly in two sentences" carries both shapes, and
     one pass would leave the other behind. Bounded rather than looped so a
     pathological input cannot spin. */
  for (let i = 0; i < 2; i++) {
    const next = out.replace(OUTPUT_INSTRUCTION_RE, "").replace(TRAILING_BREVITY_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  /* NEVER RETURN LESS THAN A QUERY. "summarize in two sentences" with no
     subject would strip to nothing, and an empty search is worse than a
     literal one: it matches everything or errors. When stripping empties it,
     the original was the whole question, so keep it. */
  return out.length >= 3 ? out : query.trim();
}

function matchSearchIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  /* CRM-shaped queries belong to the CRM tools. Check FIRST so the
     more-specific intent always wins regardless of registration
     order. */
  if (crmToolClaims(trimmed)) return null;

  /* "what does the SOW say" is the question a document library exists to
     answer, and it reached no tool at all until 2026-08-26. Checked before the
     imperative form because it is a different shape, not a variant of it. */
  const asked = matchDocumentQuestion(trimmed);
  if (asked && !specificToolClaims(trimmed)) return { query: stripOutputInstruction(asked) };

  const m = INTENT_RE.exec(trimmed);
  if (!m) return addressQuery(trimmed) ?? bareIdentifierQuery(trimmed);
  const query = stripOutputInstruction(m[1].trim().replace(/[?.!,]+$/g, "").trim());
  if (!query) return null;
  /* Reject queries that look like a CRM ID lookup — these still get
     captured by the broad "find <X>" arm but belong to
     get_external_record. The CRM tools' matchIntent already does the
     heavy lifting; this is a backup so single-word ALL-CAPS IDs
     ("ACME") don't fire a Graph search. */
  if (/^[A-Z0-9_-]{3,12}$/.test(query) && !query.includes(" ")) return null;

  const surface = m[2]?.toLowerCase();
  let types: SearchType[] | undefined;
  if (surface) {
    const mapped = SURFACE_TO_TYPE[surface];
    if (mapped && mapped !== "all") types = [mapped];
  }
  const params: Params = { query };
  if (types) params.types = types;
  return params;
}

/* ---------------------------------------------------------------------
 * Answer rendering
 * ------------------------------------------------------------------- */

/**
 * What each bucket is called when it has something in it.
 *
 * Keyed by the provider's countKey. `search-summary-labels` in the tool tests
 * asserts every registered provider has an entry, so a new provider cannot
 * return results that the sentence has no word for.
 */
const COUNT_LABELS: Record<string, [singular: string, plural: string]> = {
  chats: ["chat", "chats"],
  channels: ["channel", "channels"],
  emails: ["email", "emails"],
  calendar: ["calendar event", "calendar events"],
  knowledge: ["knowledge entry", "knowledge entries"],
  brain: ["document", "documents"],
  crm: ["CRM record", "CRM records"],
  dms: ["inventory match", "inventory matches"],
  vercel: ["deployment", "deployments"],
  /* Distinct from "document", which is our ingested copy. A reader seeing both
     words in one sentence is being told something true: some of these we hold,
     and some are still sitting in their SharePoint where we found them. */
  sharepoint: ["SharePoint file", "SharePoint files"],
};

/**
 * NAMES WHAT WAS FOUND, rather than reciting what was not.
 *
 * This used to enumerate every bucket in a fixed sentence, which had two
 * problems. It read as broken: adding the document corpus produced "Found 3
 * results for guest feedback: 0 chats, 0 channels, 0 emails, 0 calendar
 * events, 0 knowledge entries, 0 CRM records, 0 inventory matches", because
 * documents had no clause and every clause that existed was zero. A person
 * reading that sees a contradiction, not an answer.
 *
 * And it drifted: the fixed sentence never mentioned deployments either, so
 * that provider had been returning results into a summary that did not count
 * them since the day it was added.
 *
 * Listing only non-empty buckets fixes both. A new provider appears in the
 * sentence as soon as it returns anything.
 */

/**
 * Words too common to narrow anything, and too common to be the typo.
 *
 * Kept short deliberately. A long stop-list starts removing the words that
 * carried the meaning.
 */
const NOISE_WORDS = new Set([
  "the", "a", "an", "our", "my", "your", "this", "that", "these", "those",
  "of", "for", "about", "on", "in", "at", "to", "and", "or", "with", "from",
  "is", "are", "was", "were", "be", "please", "show", "me", "find", "get",
]);

/**
 * A second attempt when the exact phrase found nothing.
 *
 * WHY THIS EXISTS, and it is the clearest evidence in the product. Measured on
 * production over 60 days: 130 answers were dead ends, and 36 of them were the
 * same query, "coaching calls spreasheet". One person, one typo, thirty-six
 * attempts, nothing back every time. They were not told the file might be
 * there under a slightly different name. They were told nothing was found, and
 * eventually they stopped asking.
 *
 * A search engine that only matches what was typed puts the burden of spelling
 * on the person asking. Dropping the least common word is a cheap way to lift
 * it: "coaching calls spreasheet" retried as "coaching calls" finds the thing,
 * and the answer can say what it looked for instead.
 *
 * LONGEST WORD FIRST, because a misspelling is usually the longest and most
 * specific token in a phrase. "spreasheet" goes before "calls", so the retry
 * keeps the words most likely to be right.
 */
export function relaxQuery(query: string): string | null {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter(Boolean);

  const meaningful = words.filter((w) => !NOISE_WORDS.has(w.toLowerCase()));
  /* One meaningful word cannot be relaxed: dropping it leaves nothing to
     search for, and a search for the noise words would match everything. */
  if (meaningful.length < 2) return null;

  const longest = meaningful.reduce((a, b) => (b.length > a.length ? b : a));
  const kept = meaningful.filter((w) => w !== longest);
  return kept.length > 0 ? kept.join(" ") : null;
}

/**
 * Name the providers that never answered, in words a reader recognises.
 *
 * Returns null on a healthy search, which is the common case and reads exactly
 * as it did before.
 */
function degradedNote(body: SearchResponse): string | null {
  const d = body.degraded ?? [];
  if (d.length === 0) return null;

  const names = d.map((x) => x.provider);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  /* "did not answer" rather than "timed out": the distinction between a
     timeout and a failure matters to us and not to the person waiting, and
     both mean the same thing to them, which is that this was not searched. */
  return `${list} did not answer in time, so ${d.length === 1 ? "it was" : "they were"} not searched`;
}

/* Exported for tests only. The wording IS the behaviour here: the defect this
   guards was a sentence that asserted something untrue, so it has to be
   assertable directly rather than through the whole tool. */
export { summaryAnswer as summaryAnswerForTests };

function summaryAnswer(query: string, body: SearchResponse, relaxedFrom?: string): string {
  const total = body.results.length;
  const degraded = degradedNote(body);

  if (total === 0) {
    /* THE LIE THIS REMOVES. "No results found" asserts that everything was
       searched and held nothing. When a provider timed out that is simply
       untrue, and it is the worst kind of untrue: confident, silent, and
       pointing the reader away from data that may be sitting right there.
       Measured 2026-08-29, the Teams channels provider ran at a p95 of
       22,136ms against a 6,000ms budget, so it routinely did not answer and
       every one of those searches still reported a clean empty result. */
    /* LEADS WITH THE FACT, THEN QUALIFIES IT. "No results found" is true: none
       were found. The lie was never that sentence, it was the silence after
       it. Keeping the opening also keeps the contract the 2026-05-19 eval
       guards, which is that the zero-results path answers from the tool
       instead of falling through to a model that would confabulate. */
    return degraded
      ? `No results found for "${query}". Note that ${degraded}, so this is not a complete answer and it is worth asking again.`
      : `No results found for "${query}".`;
  }

  /* SAY WHAT IT ACTUALLY LOOKED FOR. A person who typed one thing and is shown
     results for another will not trust either, and the difference is usually
     the word they misspelled. */
  if (relaxedFrom) {
    const parts: string[] = [];
    for (const [key, n] of Object.entries(body.counts)) {
      if (!n) continue;
      const label = COUNT_LABELS[key];
      parts.push(`${n} ${label ? (n === 1 ? label[0] : label[1]) : key}`);
    }
    const breakdown = parts.length > 0 ? `: ${parts.join(", ")}` : "";
    const note = degraded ? ` ${degraded[0]!.toUpperCase()}${degraded.slice(1)}.` : "";
    return (
      `I could not find "${relaxedFrom}", so I looked for "${query}" instead ` +
      `and found ${total} result${total === 1 ? "" : "s"}${breakdown}.${note}`
    );
  }

  const parts: string[] = [];
  for (const [key, n] of Object.entries(body.counts)) {
    if (!n) continue;
    const label = COUNT_LABELS[key];
    parts.push(`${n} ${label ? (n === 1 ? label[0] : label[1]) : key}`);
  }

  const breakdown = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  /* PARTIAL RESULTS ARE THE SAME LIE, QUIETLY. "Found 3 results" reads as the
     complete set, and somebody who stops reading there never learns that a
     source was skipped. Naming it costs one clause and is the difference
     between an answer they can act on and one they cannot. */
  const suffix = degraded ? ` ${degraded[0]!.toUpperCase()}${degraded.slice(1)}.` : "";
  return `Found ${total} result${total === 1 ? "" : "s"} for "${query}"${breakdown}.${suffix}`;
}

/** Map runSearch hits onto AssistantSourceRef shape. Each result type
 *  maps to a citation `type` the chat surface knows how to badge. */
function buildSources(body: SearchResponse): AssistantSourceRef[] {
  const TYPE_MAP: Record<SearchType, string> = {
    chat: "chat",
    channel: "channel",
    email: "email",
    calendar: "meeting",
    /* A SharePoint hit cites as a document: it IS one, and the reader does not
       need to know whether we found it in our index or in theirs. */
    sharepoint: "document",
    /* Documents cite as documents. The corpus is mostly SharePoint files, and
       a reader who sees "document" knows what they are being shown. */
    brain: "document",
    knowledge: "knowledge",
    crm: "crm",
    dms: "dms",
    vercel: "vercel",
  };
  const out: AssistantSourceRef[] = [];
  const seen = new Set<string>();
  for (const r of body.results.slice(0, 5)) {
    /* De-dupe by id+type — runSearch can in principle return the same
       chat id twice (preview match + body match) and the chat handler
       guards against it, but defending here keeps the citation
       surface clean regardless of upstream changes. */
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      title: r.title,
      url: r.url ?? "",
      type: TYPE_MAP[r.type] ?? r.type,
    });
  }
  return out;
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const searchTool: ToolDef<Params, SearchResponse> = {
  name: "search",
  description:
    "Universal Search across the user's chats, channels, emails, calendar, and Instinct knowledge. Returns identical results to the /search page.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchSearchIntent,
  async handler(params, ctx): Promise<ToolResult<SearchResponse>> {
    try {
      const runParams: RunSearchParams = {
        query: params.query,
        ...(params.types ? { types: params.types } : {}),
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
      };
      const searchCtx = {
        userId: ctx.userId,
        ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
      };
      let body = await runSearch(runParams, searchCtx);

      /* A SECOND ATTEMPT BEFORE GIVING UP.
       *
       * Measured on production over 60 days: 130 answers were dead ends, and
       * 36 of them were one query, "coaching calls spreasheet". One person,
       * one typo, thirty-six attempts, nothing back every time. They were
       * never told the file might be there under a slightly different name.
       *
       * Retrying without the least likely word costs one query on the rare
       * path where the first found nothing, and turns the commonest dead end
       * in the product into an answer. */
      let relaxedFrom: string | undefined;
      if (body.results.length === 0) {
        const relaxed = relaxQuery(params.query);
        if (relaxed) {
          const second = await runSearch({ ...runParams, query: relaxed }, searchCtx);
          if (second.results.length > 0) {
            relaxedFrom = params.query;
            runParams.query = relaxed;
            body = second;
            trackEvent("assistant.search_relaxed", ctx.userId, ctx.userRole, {
              original_length: params.query.length,
              relaxed_length: relaxed.length,
              results: second.results.length,
              ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
            });
          }
        }
      }

      const typesLabel = (params.types ?? [
        "chat",
        "channel",
        "email",
        "calendar",
        "knowledge",
        "crm",
      ]).join(",");

      /* Analytics — mirrors the page surface's `insight.search.queried`
         but namespaced under assistant.* so the learning loop can
         distinguish chat-driven from page-driven searches. */
      trackEvent("assistant.search_executed", ctx.userId, ctx.userRole, {
        query_length: params.query.length,
        total_results: body.results.length,
        took_ms: body.took_ms,
        types: typesLabel,
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });
      if (body.results.length === 0) {
        trackEvent(
          "assistant.search_no_results",
          ctx.userId,
          ctx.userRole,
          {
            query_length: params.query.length,
            types: typesLabel,
            ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
          },
        );
      }

      return {
        ok: true,
        data: body,
        answer: summaryAnswer(runParams.query, body, relaxedFrom),
        sources: buildSources(body),
        /* Inline interactive surface: the SearchResultsWidget renders
         *  the per-source filter checkboxes + result rows in chat so
         *  the user can narrow / refilter without leaving the
         *  conversation. The shape is identical to the SearchResponse
         *  data above; the widget renderer owns its own client-side
         *  filter state. */
        widget: {
          kind: "search_results",
          query: params.query,
          results: body.results.map((r) => ({
            type: r.type,
            id: r.id,
            title: r.title,
            snippet: r.snippet,
            timestamp: r.timestamp,
            ...(r.url ? { url: r.url } : {}),
          })),
          counts: { ...body.counts },
          took_ms: body.took_ms,
        },
      };
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `search error: ${(err as Error)?.message ?? "unknown"}`,
      };
    }
  },
};

registerTool(searchTool);

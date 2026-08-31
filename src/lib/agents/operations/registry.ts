/**
 * Declarative agent operation registry.
 *
 * The premise: an agent should be able to invoke ANY platform function it has
 * scanned, with NO per-function handler code. An "operation" is a few
 * declarative lines naming the HTTP method + path of an existing internal route,
 * the intent phrasing that should route to it, the capability needed, and the
 * fields to pull out of the instruction. The tool factory (tool-factory.ts)
 * turns every entry here into an agent-only assistant tool, the scan reports
 * them so the agent's system model shows what it can do, and the executor
 * invokes the chosen operation AS THE OWNER through the existing on-behalf
 * delegation token.
 *
 * Adding a new operation is intentionally cheap: append one AgentOperation,
 * point each field at a pure extractor from extract.ts, and the tool, the scan
 * entry, and the on-behalf execution path all come for free. No bespoke handler,
 * no new route wiring, no dispatcher change.
 *
 * Security is NOT relaxed here: an operation names the capability the owner must
 * hold, the scan marks `allowed` using the same gate the dispatcher uses, and
 * the executor mints a fresh, short-lived on-behalf token carrying the OWNER's
 * role (never elevated). The downstream route still enforces the owner's own
 * authority exactly as it would for a human request.
 */

import {
  extractDocumentBody,
  extractDocumentTitle,
  extractEmailSubject,
  extractLabel,
  extractRecipient,
  extractSearchQuery,
  extractUrl,
} from "./extract";

/** One declarative field of an operation: how to pull its value from the
 *  natural-language instruction, and whether the operation needs it. */
export interface OperationField {
  /** The request-body (or query) key this value maps to. */
  name: string;
  /** When true, a missing value makes the executor escalate to the owner. */
  required: boolean;
  /** Pure extractor: pull this field's value from the instruction, or undefined. */
  extract(instruction: string): string | undefined;
}

/**
 * A declarative, invocable platform operation. The method + path name an
 * EXISTING internal route; the agent calls it on the owner's behalf. `intent`
 * decides when an instruction routes here; `capability` is the role the owner
 * must hold (mirrors a tool's capability; "*" = any authenticated principal).
 */
export interface AgentOperation {
  /** Stable id, snake_case. The tool is named `op_${id}`. Used in analytics. */
  id: string;
  /** One-line, human-readable description of what the operation does. */
  summary: string;
  /** Intent classifier: when this matches the instruction, route here. */
  intent: RegExp;
  /** HTTP method of the underlying internal route. */
  method: "POST" | "GET" | "PATCH" | "PUT" | "DELETE";
  /** Path of the underlying internal route, e.g. "/api/qr". */
  path: string;
  /** Capability the OWNER must hold ("*" = any authenticated principal). */
  capability: string;
  /** Declarative field extraction. Required fields gate execution. */
  fields: OperationField[];
  /**
   * Result chaining: the name of a body-like field that should be filled from
   * the carried output of EARLIER steps when the instruction refers back to it
   * ("summarize the results") and the field is otherwise empty. The executor
   * folds in a concise, capped join of prior-step output before the required
   * gate, reusing the exact form-path helper. Undefined = no chaining.
   */
  fillFromPriorResults?: string;
}

/**
 * The seeded operations. Deliberately ONE entry: the point is to prove a brand
 * new platform function becomes agent-invocable in a few declarative lines, with
 * no per-function handler code anywhere. Append more here as routes are exposed.
 */
export const AGENT_OPERATIONS: AgentOperation[] = [
  {
    id: "create_qr_code",
    summary: "Create a QR code linked to a URL",
    // "create/make/generate/new/add ... qr (code)". Tolerates words between the
    // verb and "qr" ("create a tracked qr code").
    intent: /\b(?:create|make|generate|new|add)\b.*\bqr(?:\s*code)?\b/i,
    method: "POST",
    path: "/api/qr",
    capability: "*",
    fields: [
      {
        name: "targetUrl",
        required: true,
        // Pull an http(s) URL or a bare domain after "linked to"/"to"/"for",
        // normalizing a bare domain like ogiam.com to https://ogiam.com.
        extract: (instruction) => extractUrl(instruction),
      },
      {
        name: "label",
        required: false,
        // Pull a "titled/called/named X" label.
        extract: (instruction) => extractLabel(instruction),
      },
    ],
  },
  {
    id: "capture_screenshot",
    summary: "Capture a screenshot of a URL as visual verification",
    // "screenshot / snapshot ..." — the required url field gates it, so a loose
    // intent is safe (no URL -> escalate to the owner).
    intent: /\bscreenshot\b|\bscreen\s*shot\b|\bsnapshot\b/i,
    method: "POST",
    path: "/api/tools/screenshot",
    // The capture route + its serving route are gated on team administration,
    // the same rank that runs agents.
    capability: "settings.manage_team",
    fields: [
      {
        name: "url",
        required: true,
        extract: (instruction) => extractUrl(instruction),
      },
    ],
  },
  {
    id: "web_search",
    summary: "Search the web for information",
    // Two routing shapes, anchored on a PUBLIC-web surface noun so this does NOT
    // swallow internal "search the knowledge base / search my mail" phrasings:
    //   (a) a search/scan/look-up/find/research verb combined with
    //       web|internet|online (in either order: "search the web", "scan the
    //       internet for X", "look X up online");
    //   (b) "search for X" / "find news on X" / "the latest news on X" - the
    //       "news" surface noun (or a bare "search for") routing to web search.
    intent:
      /\b(?:search|scan|look(?:\s*up)?|lookup|find|research|google)\b.*\b(?:web|internet|online)\b|\b(?:web|internet|online)\b.*\b(?:search|scan|look(?:\s*up)?|lookup|find|research)\b|\b(?:search\s+for|find\s+news|latest\s+news|news)\b/i,
    method: "POST",
    path: "/api/web-search",
    capability: "*",
    fields: [
      {
        name: "query",
        required: true,
        // Pull the search terms after for/about/on, else the meaningful remainder.
        extract: (instruction) => extractSearchQuery(instruction),
      },
    ],
  },
  {
    id: "create_document",
    summary: "Create a document or written summary in the knowledge base",
    // "create/make/write/draft/... a document|summary|write-up|brief|report|memo|
    //  doc ...", or a bare "summarize/summarize ...". Anchored on a document-like
    // surface noun so it does not swallow "create a task"/"create an event".
    intent:
      /\b(?:create|make|write|draft|compose|generate|produce|prepare|save|put\s+together)\b[^.!?]*\b(?:document|summary|write[\s-]?up|writeup|brief|report|memo|doc)\b|\bsummari[sz]e\b/i,
    method: "POST",
    path: "/api/knowledge",
    // The knowledge create path accepts any role holding knowledge.search; the
    // OWNER must hold it, enforced by the same gate as every other operation.
    capability: "knowledge.search",
    fields: [
      {
        // The knowledge route stores the title under `question`.
        name: "question",
        required: true,
        extract: (instruction) => extractDocumentTitle(instruction),
      },
      {
        // The body. Filled inline when dictated, else from prior results below.
        name: "answer",
        required: true,
        extract: (instruction) => extractDocumentBody(instruction),
      },
      {
        // Provenance marker for the audit + learning loop: agent-authored.
        name: "source",
        required: false,
        extract: () => "agent",
      },
    ],
    // "Create a document summary of the results" carries the prior step's output
    // into the body, so a chained search -> summarize lands a real document.
    fillFromPriorResults: "answer",
  },
  {
    id: "draft_email",
    summary: "Draft a follow-up email for review (created in Drafts, not sent)",
    // "draft/compose/prepare/write ... a follow-up | email | message | reply |
    // note". Anchored on a mail noun so it does not collide with create_document
    // (document/summary) or the send path. Deliberately excludes "send": an
    // actual send is the human-approved action, a draft is the safe agent step.
    intent:
      /\b(?:draft|compose|prepare|write)\b[^.!?]*\b(?:e-?mail|message|reply|note|follow[\s-]?up)\b/i,
    method: "POST",
    path: "/api/mail/draft",
    // Compose authority. The draft has no external effect; the gate keeps an
    // actual send escalated to the owner.
    capability: "emails.send",
    fields: [
      {
        name: "to",
        required: true,
        extract: (instruction) => extractRecipient(instruction),
      },
      {
        name: "subject",
        required: false,
        extract: (instruction) => extractEmailSubject(instruction),
      },
      {
        // Maps to the route's bodyText. Filled inline ("...saying X") or, for a
        // chained "draft a follow-up about the results", from prior step output.
        name: "bodyText",
        required: true,
        extract: (instruction) => extractDocumentBody(instruction),
      },
    ],
    fillFromPriorResults: "bodyText",
  },
];

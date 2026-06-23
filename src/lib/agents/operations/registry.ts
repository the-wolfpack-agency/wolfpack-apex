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

import { extractLabel, extractUrl } from "./extract";

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
];

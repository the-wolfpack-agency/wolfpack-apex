/**
 * create_crm_record_form — surfaces a vendor-aware form for creating
 * a CRM record (Salesforce Opportunity / Contact / Account / Task or
 * HubSpot equivalents).
 *
 * REPLACES the legacy create_external_record regex-confirmation flow
 * for "create deal" / "create contact" / "create account" phrasings.
 * That flow was brittle: "create a $10k deal with Jesus Christ"
 * parsed the name + amount but missed StageName + CloseDate (which
 * Salesforce requires) — the write 400'd at the vendor and the user
 * blamed the assistant.
 *
 * This tool returns a form whose required fields match the vendor's
 * minimum-viable accept set, so the write succeeds on first submit:
 *
 *   - Opportunity: Name, Amount, StageName, CloseDate (all required)
 *   - Contact:     LastName (required), FirstName + Email optional
 *   - Account:     Name (required)
 *   - Task:        Subject (required)
 *
 * Registration order: BEFORE create_external_record_tool so this
 * claims the structured-create phrasings; the legacy tool still
 * handles "log a call with Jorge about pricing" (action verb +
 * subject phrase) which doesn't match this regex.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { crmRecordFormSpec } from "@/lib/assistant/forms/specs";

const ObjectType = z.enum(["deal", "contact", "account", "task"]);

const ParamSchema = z.object({
  objectType: ObjectType,
  name: z.string().min(1).max(200).optional(),
  amount: z.string().min(1).max(20).optional(),
  email: z.string().email().optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateCrmRecordFormData {
  formKind: "create_crm_record";
  objectType: z.infer<typeof ObjectType>;
}

/* Detection — phrase must include create-verb + object-noun. We
 * require the object word so generic "create" phrases (like
 * "create email" / "create task" for MS To-Do) take their dedicated
 * tools first. */
const VERB = /\b(?:create|add|new|make)\b/i;
const OBJECT_RE =
  /\b(deal|opportunit(?:y|ies)|contact|person|account|company|companies|crm\s+task)\b/i;
const OBJECT_ALIAS: Record<string, "deal" | "contact" | "account" | "task"> = {
  deal: "deal", opportunity: "deal", opportunities: "deal",
  contact: "contact", person: "contact",
  account: "account", company: "account", companies: "account",
  "crm task": "task",
};

const AMOUNT_RE = /\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*([kKmM])?/;
const EMAIL_RE = /([\w.+-]+@[\w-]+\.[\w.-]+)/i;
const NAME_AFTER_OBJECT_RE =
  /\b(?:with|for|named|called|titled)\s+([A-Z][\w'.& -]{1,80})\b/;

function matchCrmRecordIntent(message: string): Params | null {
  if (!VERB.test(message)) return null;
  const objMatch = OBJECT_RE.exec(message);
  if (!objMatch) return null;
  const key = objMatch[1].toLowerCase().replace(/\s+/g, " ");
  const objectType = OBJECT_ALIAS[key];
  if (!objectType) return null;

  /* For "task" — only claim "CRM task". Bare "create task" goes to
     the MS To-Do form tool. */
  if (objectType === "task" && !/\bcrm\s+task\b/i.test(message)) return null;

  const params: Params = { objectType };
  const am = AMOUNT_RE.exec(message);
  if (am) {
    const base = Number(am[1].replace(/,/g, ""));
    if (Number.isFinite(base)) {
      const suffix = am[2]?.toLowerCase();
      const v =
        suffix === "k" ? base * 1000 :
        suffix === "m" ? base * 1_000_000 :
        base;
      params.amount = String(v);
    }
  }
  const em = EMAIL_RE.exec(message);
  if (em) params.email = em[1];
  const nm = NAME_AFTER_OBJECT_RE.exec(message);
  if (nm) params.name = nm[1].trim();
  return params;
}

export const createCrmRecordFormTool: ToolDef<Params, CreateCrmRecordFormData> = {
  name: "create_crm_record_form",
  description:
    "Surface a vendor-aware form in the chat for creating a CRM Opportunity / Contact / Account / Task. Required fields match what the vendor needs to accept the write.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchCrmRecordIntent,
  async handler(params, ctx): Promise<ToolResult<CreateCrmRecordFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_crm_record",
      object_type: params.objectType,
      prefilled_name: params.name ? true : false,
      prefilled_amount: params.amount ? true : false,
      prefilled_email: params.email ? true : false,
    });
    return {
      ok: true,
      data: { formKind: "create_crm_record", objectType: params.objectType },
      answer:
        params.objectType === "deal"
          ? "Fill in the deal below. Stage and Close date have safe defaults."
          : params.objectType === "contact"
          ? "Fill in the contact below."
          : params.objectType === "account"
          ? "Fill in the account below."
          : "Fill in the CRM task below.",
      form: crmRecordFormSpec({
        crmObjectType: params.objectType,
        crmName: params.name,
        crmAmount: params.amount,
        crmEmail: params.email,
      }),
    };
  },
};

registerTool(createCrmRecordFormTool);

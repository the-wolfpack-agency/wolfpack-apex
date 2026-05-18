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
import {
  crmRecordFormSpec,
  crmRecordFormSpecFromDescribe,
} from "@/lib/assistant/forms/specs";
import { describeCrmObject } from "@/lib/integrations/describe-crm";
import { pickConfiguredConnector } from "@/lib/assistant/connectors/credentials";

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
/* Stop the name at common adjoining fields ("email", "amount", "phone",
 * "at", "of", currency signs) so "named Jane Doe email jane@acme.com"
 * captures "Jane Doe" rather than "Jane Doe email jane". */
const NAME_AFTER_OBJECT_RE =
  /\b(?:with|for|named|called|titled)\s+([A-Z][\w'.& -]{1,80}?)(?=\s+(?:email|amount|phone|address|at|of|for|with)\b|\s*[,$@]|$)/;

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
    const workspaceId = ctx.workspaceId ?? "default";
    /* Pick the CRM connector configured for this workspace so the
     * describe call targets the right vendor. Falls back to legacy
     * hand-curated spec if no connector is configured. */
    const configured = await pickConfiguredConnector(workspaceId).catch(() => null);
    const vendor =
      configured === "salesforce" || configured === "hubspot" ? configured : null;

    let formSpec = null as ReturnType<typeof crmRecordFormSpecFromDescribe> | null;
    let describeSource: "live" | "fallback" | "none" = "none";

    if (vendor) {
      const result = await describeCrmObject(vendor, params.objectType, workspaceId);
      describeSource = result.source;
      if (result.fields.length > 0) {
        formSpec = crmRecordFormSpecFromDescribe({
          objectType: params.objectType,
          vendor,
          fields: result.fields,
          source: result.source,
          prefill: {
            crmObjectType: params.objectType,
            crmName: params.name,
            crmAmount: params.amount,
            crmEmail: params.email,
          },
        });
      }
    }

    /* Fall back to the legacy hand-curated spec when describe yielded
     * nothing (no connector, no template, vendor unsupported). The
     * old form still writes through the same submit endpoint, so the
     * user gets a working form regardless. */
    const finalForm =
      formSpec ??
      crmRecordFormSpec({
        crmObjectType: params.objectType,
        crmName: params.name,
        crmAmount: params.amount,
        crmEmail: params.email,
      });

    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_crm_record",
      object_type: params.objectType,
      prefilled_name: params.name ? true : false,
      prefilled_amount: params.amount ? true : false,
      prefilled_email: params.email ? true : false,
      describe_source: formSpec ? describeSource : "hand_curated",
      field_count: finalForm.fields.length,
    });

    /* Phase-3 contract: the answer string says what we're about to
     * do AND asks the user to confirm via the form submit. Submitting
     * the form IS the confirmation — we never silently fire the write
     * on the first turn. Threading the parsed name through the answer
     * (when present) makes the preview specific instead of generic. */
    const subject = params.name ? ` for ${params.name}` : "";
    return {
      ok: true,
      data: { formKind: "create_crm_record", objectType: params.objectType },
      answer:
        params.objectType === "deal"
          ? `Create a deal${subject}. Stage and Close date have safe defaults — confirm by submitting the form below.`
          : params.objectType === "contact"
          ? `Create a contact${subject}. Confirm by submitting the form below.`
          : params.objectType === "account"
          ? `Create an account${subject}. Confirm by submitting the form below.`
          : `Create a CRM task${subject}. Confirm by submitting the form below.`,
      form: finalForm,
    };
  },
};

registerTool(createCrmRecordFormTool);

/**
 * HR Documents — unified store + smart router for every HR doc Alicia
 * uploads.
 *
 * Self-contained, zero external API calls. Classification is a pure
 * deterministic function over the extracted PDF text — no AI tokens.
 * The brain learns from Alicia's manual recategorizations over time
 * via tracked events (we count signature → category mappings and the
 * scoring rules can be tuned in code without burning tokens).
 *
 * Public surface:
 *   - classifyDocument(text)              — heuristic, never throws
 *   - parseAndClassify(filename, buffer)  — full upload pipeline
 *   - storeHrDocument(doc, ...)           — persist + emit events
 *   - listHrDocuments(filter?)
 *   - getHrDocument(id)
 *   - recategorizeDocument(id, category, ...)
 *   - linkDocumentToEmployee(id, employeeId, ...)
 *   - deleteHrDocument(id, ...)
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { parseBenefitDocument, saveBenefitDocument, generateRecommendation, saveRecommendation, generateBenefitInsights, saveInsights } from "@/lib/benefits";

/* ---------------------------- Types ---------------------------------- */

export const HR_CATEGORIES = [
  "w4",
  "i9",
  "benefits_renewal",
  "offer_letter",
  "handbook",
  "unclassified",
] as const;
export type HrCategory = (typeof HR_CATEGORIES)[number];

export interface ClassificationResult {
  category: HrCategory;
  confidence: number; // 0..1
  reasons: string[];
}

export interface HrDocument {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  page_count: number | null;
  category: HrCategory;
  classification_confidence: number | null;
  classification_reasons: string[];
  employee_id: string | null;
  benefit_document_id: string | null;
  raw_text_excerpt: string;
  signed_at: string | null;
  expires_at: string | null;
  status: "active" | "archived" | "expired";
  uploaded_by: string;
  uploaded_at: string;
  updated_at: string;
}

/* ------------------------- Classifier --------------------------------- */

/**
 * Each rule contributes confidence points when its signature is found.
 * The category with the highest score wins (must beat MIN_THRESHOLD).
 */
interface Rule {
  category: HrCategory;
  signature: RegExp;
  weight: number;
  reason: string;
}

const RULES: Rule[] = [
  // W-4: federal withholding form
  { category: "w4", signature: /\bForm W[-\u2013]?4\b/i, weight: 0.5, reason: "Form W-4 header" },
  { category: "w4", signature: /Employee'?s Withholding Certificate/i, weight: 0.4, reason: "Withholding certificate phrase" },
  { category: "w4", signature: /Multiple Jobs Worksheet/i, weight: 0.2, reason: "W-4 worksheet section" },
  { category: "w4", signature: /Step\s+1[\s\S]{0,40}Personal Information/i, weight: 0.2, reason: "W-4 step layout" },

  // I-9: employment eligibility verification
  { category: "i9", signature: /\bForm I[-\u2013]?9\b/i, weight: 0.5, reason: "Form I-9 header" },
  { category: "i9", signature: /Employment Eligibility Verification/i, weight: 0.5, reason: "Eligibility verification phrase" },
  { category: "i9", signature: /USCIS|U\.S\. Citizenship and Immigration Services/i, weight: 0.3, reason: "USCIS reference" },
  { category: "i9", signature: /List A\b[\s\S]{0,200}List B\b[\s\S]{0,200}List C\b/i, weight: 0.3, reason: "I-9 List A/B/C structure" },

  // Benefits renewal: BCBS-style exhibit or generic
  { category: "benefits_renewal", signature: /Medical Plans|Plan ID/i, weight: 0.3, reason: "Medical plans header" },
  { category: "benefits_renewal", signature: /Renewal Effective Date|Renewal Generation/i, weight: 0.4, reason: "Renewal date phrase" },
  { category: "benefits_renewal", signature: /Blue (?:Choice|Advantage|Cross)|HMO Network|PPO Network/i, weight: 0.3, reason: "Carrier network header" },
  { category: "benefits_renewal", signature: /Deductible[\s\S]{0,50}Out-of-Pocket Max/i, weight: 0.2, reason: "Deductible/OOP table" },
  { category: "benefits_renewal", signature: /\b[A-Z][A-Z0-9]{5,7}\b[\s\S]{0,40}\$\d/i, weight: 0.2, reason: "Plan ID + price pattern" },

  // Offer letter
  { category: "offer_letter", signature: /(?:Offer of Employment|Employment Agreement|Offer Letter)/i, weight: 0.5, reason: "Offer letter title" },
  { category: "offer_letter", signature: /annual (?:base )?(?:salary|compensation)/i, weight: 0.3, reason: "Salary clause" },
  { category: "offer_letter", signature: /at[- ]will employment/i, weight: 0.2, reason: "At-will clause" },
  { category: "offer_letter", signature: /start date|first day of employment/i, weight: 0.2, reason: "Start date clause" },

  // Employee handbook
  { category: "handbook", signature: /Employee Handbook|Code of Conduct/i, weight: 0.5, reason: "Handbook title" },
  { category: "handbook", signature: /Paid Time Off|PTO Policy|Vacation Policy/i, weight: 0.3, reason: "PTO policy section" },
  { category: "handbook", signature: /Anti[- ]Harassment|Workplace Conduct/i, weight: 0.2, reason: "Conduct policy section" },
];

const MIN_THRESHOLD = 0.4;

export function classifyDocument(text: string): ClassificationResult {
  if (!text || text.trim().length === 0) {
    return { category: "unclassified", confidence: 0, reasons: ["empty text"] };
  }
  const scores = new Map<HrCategory, number>();
  const reasons = new Map<HrCategory, string[]>();
  for (const rule of RULES) {
    if (rule.signature.test(text)) {
      scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
      const r = reasons.get(rule.category) ?? [];
      r.push(rule.reason);
      reasons.set(rule.category, r);
    }
  }
  if (scores.size === 0) {
    return { category: "unclassified", confidence: 0, reasons: ["no signature matched"] };
  }
  // Pick highest score
  let best: HrCategory = "unclassified";
  let bestScore = 0;
  for (const [cat, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  // Cap confidence at 1.0
  const confidence = Math.min(bestScore, 1);
  if (confidence < MIN_THRESHOLD) {
    return {
      category: "unclassified",
      confidence,
      reasons: [`top match was ${best} but confidence ${confidence.toFixed(2)} < ${MIN_THRESHOLD}`],
    };
  }
  return {
    category: best,
    confidence,
    reasons: reasons.get(best) ?? [],
  };
}

/* ------------------------- Smart router pipeline --------------------- */

export interface RoutedUploadResult {
  documentId: string;
  filename: string;
  category: HrCategory;
  confidence: number;
  reasons: string[];
  benefitDocumentId?: string;
  benefitPlanCount?: number;
  benefitRecommendation?: { id: string; plan_id: string; reasoning: string } | null;
}

/**
 * Full smart-router upload pipeline:
 *   1. Extract text from PDF (via benefits parseBenefitDocument helper —
 *      we reuse the same unpdf-backed extractor)
 *   2. Classify with the deterministic rule engine
 *   3. Persist row in apex_hr_documents
 *   4. If classified as benefits_renewal, ALSO run the benefit
 *      parsing pipeline so the Benefits tab has its plans + rec
 *   5. Emit hr.document_uploaded + hr.document_classified events
 */
export async function routeUpload(
  filename: string,
  buffer: Buffer,
  uploadedBy: string,
  userRole: string,
  source: "documents_tab" | "benefits_tab",
): Promise<RoutedUploadResult> {
  // Extract text via the same unpdf-backed extractor benefits uses.
  // parseBenefitDocument returns plans=[] for non-benefits PDFs but
  // text + page_count are still populated from the extractor.
  const parsed = await parseBenefitDocument(filename, buffer);

  // Classify on the full extracted text
  const fullText = parsed.raw_text_excerpt; // already capped at 2000 chars in v1
  const classification = classifyDocument(fullText);

  trackEvent("hr.document_uploaded", uploadedBy, userRole, {
    filename,
    size_bytes: buffer.length,
    source,
  });
  trackEvent(
    source === "benefits_tab" ? "hr.document_filed_via_benefits_tab" : "hr.document_filed_via_documents_tab",
    uploadedBy,
    userRole,
    { filename, classified_as: classification.category },
  );

  let benefitDocumentId: string | undefined;
  let benefitPlanCount: number | undefined;
  let benefitRecommendationOut: { id: string; plan_id: string; reasoning: string } | null = null;

  // If the classifier says it's a benefits renewal, run the benefits
  // pipeline so the Benefits tab has its plans + recommendation.
  if (classification.category === "benefits_renewal" && parsed.plans.length > 0) {
    const saved = await saveBenefitDocument(parsed, uploadedBy, userRole);
    benefitDocumentId = saved.documentId;
    benefitPlanCount = parsed.plans.length;
    const rec = generateRecommendation(parsed.plans, "cheapest_practical");
    if (rec) {
      const recId = await saveRecommendation(rec, saved.documentId, uploadedBy, userRole);
      benefitRecommendationOut = { id: recId, plan_id: rec.plan.plan_id, reasoning: rec.reasoning };
    }
    const insights = generateBenefitInsights(parsed.plans);
    if (insights.length > 0) await saveInsights(insights, uploadedBy, userRole);
  }

  // Always store an apex_hr_documents row as the system of record
  const documentId = `hd_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO apex_hr_documents
       (id, filename, mime_type, size_bytes, page_count, category,
        classification_confidence, classification_reasons,
        benefit_document_id, raw_text_excerpt, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      documentId,
      filename,
      "application/pdf",
      buffer.length,
      parsed.page_count,
      classification.category,
      classification.confidence,
      JSON.stringify(classification.reasons),
      benefitDocumentId ?? null,
      parsed.raw_text_excerpt,
      uploadedBy,
    ],
  );

  trackEvent("hr.document_classified", uploadedBy, userRole, {
    document_id: documentId,
    category: classification.category,
    confidence: classification.confidence,
    reasons: classification.reasons.join("; "),
  });

  return {
    documentId,
    filename,
    category: classification.category,
    confidence: classification.confidence,
    reasons: classification.reasons,
    benefitDocumentId,
    benefitPlanCount,
    benefitRecommendation: benefitRecommendationOut,
  };
}

/* ---------------------------- CRUD ----------------------------------- */

function rowToHrDocument(row: Record<string, unknown>): HrDocument {
  return {
    id: row.id as string,
    filename: row.filename as string,
    mime_type: (row.mime_type as string) ?? null,
    size_bytes: Number(row.size_bytes ?? 0),
    page_count: row.page_count != null ? Number(row.page_count) : null,
    category: row.category as HrCategory,
    classification_confidence: row.classification_confidence != null ? Number(row.classification_confidence) : null,
    classification_reasons: Array.isArray(row.classification_reasons)
      ? (row.classification_reasons as string[])
      : typeof row.classification_reasons === "string"
        ? JSON.parse(row.classification_reasons)
        : [],
    employee_id: (row.employee_id as string) ?? null,
    benefit_document_id: (row.benefit_document_id as string) ?? null,
    raw_text_excerpt: (row.raw_text_excerpt as string) ?? "",
    signed_at: (row.signed_at as string) ?? null,
    expires_at: (row.expires_at as string) ?? null,
    status: (row.status as HrDocument["status"]) ?? "active",
    uploaded_by: row.uploaded_by as string,
    uploaded_at: row.uploaded_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function listHrDocuments(filter?: { category?: HrCategory }): Promise<HrDocument[]> {
  if (filter?.category) {
    const r = await safeQuery(
      `SELECT * FROM apex_hr_documents WHERE category = $1 AND status = 'active' ORDER BY uploaded_at DESC`,
      [filter.category],
    );
    return r.rows.map(rowToHrDocument);
  }
  const r = await safeQuery(
    `SELECT * FROM apex_hr_documents WHERE status = 'active' ORDER BY uploaded_at DESC`,
  );
  return r.rows.map(rowToHrDocument);
}

export async function getHrDocument(id: string): Promise<HrDocument | null> {
  const r = await safeQuery(`SELECT * FROM apex_hr_documents WHERE id = $1`, [id]);
  if (r.rows.length === 0) return null;
  return rowToHrDocument(r.rows[0]);
}

export async function recategorizeDocument(
  id: string,
  newCategory: HrCategory,
  changedBy: string,
  userRole: string,
): Promise<HrDocument | null> {
  const r = await safeQuery(
    `UPDATE apex_hr_documents
        SET category = $2, updated_at = NOW()
      WHERE id = $1
  RETURNING *`,
    [id, newCategory],
  );
  if (r.rows.length === 0) return null;
  trackEvent("hr.document_recategorized", changedBy, userRole, {
    document_id: id,
    new_category: newCategory,
  });
  return rowToHrDocument(r.rows[0]);
}

export async function linkDocumentToEmployee(
  id: string,
  employeeId: string,
  changedBy: string,
  userRole: string,
): Promise<HrDocument | null> {
  const r = await safeQuery(
    `UPDATE apex_hr_documents
        SET employee_id = $2, updated_at = NOW()
      WHERE id = $1
  RETURNING *`,
    [id, employeeId],
  );
  if (r.rows.length === 0) return null;
  trackEvent("hr.document_linked_to_employee", changedBy, userRole, {
    document_id: id,
    employee_id: employeeId,
  });
  return rowToHrDocument(r.rows[0]);
}

export async function deleteHrDocument(id: string, deletedBy: string, userRole: string): Promise<boolean> {
  const r = await safeQuery(
    `DELETE FROM apex_hr_documents WHERE id = $1 RETURNING id`,
    [id],
  );
  if (r.rows.length === 0) return false;
  trackEvent("hr.document_deleted", deletedBy, userRole, { document_id: id });
  return true;
}

/**
 * Benefits library — Instinct's People > Benefits sub-tab.
 *
 * Self-contained: PDF parsing via pdf-parse npm package, scoring via
 * deterministic TypeScript rules. NO external API calls, NO API tokens
 * required, NO env-var blockers. Demo-safe by design.
 *
 * Three responsibilities:
 *   1. parseBenefitDocument(pdfBuffer) — extract carrier, account,
 *      effective date, and ALL plan rows from a renewal PDF
 *   2. scorePlans(plans) — apply named rules ("cheapest_practical",
 *      "lowest_premium", "best_for_age") and return ranked output
 *   3. generateRecommendation(plans, rule) — pick the winner + the
 *      reasoning string Alicia sees in the UI
 *
 * Closed-loop: every parse/score/recommendation emits a tracked event.
 * Recommendations are also persisted as rows so the brain can learn
 * which suggestions are accepted vs rejected over time.
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

/* ----------------------------- Types ---------------------------------- */

export type MetalTier = "Platinum" | "Gold" | "Silver" | "Bronze" | null;
export type Network = "PPO" | "HMO" | "EPO" | "POS" | null;

export interface BenefitPlan {
  plan_id: string;                 // carrier code, e.g. "S9N1ADT"
  plan_name?: string;
  network: Network;
  metal_tier: MetalTier;
  is_hsa: boolean;
  individual_deductible_in_network: number | null;
  individual_deductible_out_of_network: number | null;
  individual_oop_max_in_network: number | null;
  individual_oop_max_out_of_network: number | null;
  primary_care_copay: string;        // raw cell text
  primary_care_copay_in_network: number | null;
  specialist_copay: string;
  specialist_copay_in_network: number | null;
  er_copay: string;
  rx_copays: string;
  monthly_premium_age_employee_only: number | null;
  monthly_premium_composite_employee_only: number | null;
  monthly_premium_age_employee_spouse: number | null;
  monthly_premium_age_employee_child: number | null;
  monthly_premium_age_employee_family: number | null;
  raw: Record<string, unknown>;
}

export interface BenefitDocument {
  filename: string;
  carrier: string | null;
  effective_date: string | null;
  account_number: string | null;
  page_count: number;
  size_bytes: number;
  raw_text_excerpt: string;
  plans: BenefitPlan[];
}

export interface ScoredPlan {
  plan: BenefitPlan;
  score: number;
  reasons: string[];
}

export type ScoringRule =
  | "cheapest_practical"
  | "lowest_premium"
  | "lowest_total_cost"
  | "best_for_chronic_care";

export interface Recommendation {
  rule: ScoringRule;
  plan: BenefitPlan;
  reasoning: string;
  score_breakdown: Record<string, unknown>;
  runners_up: ScoredPlan[];
}

/* --------------------------- PDF parsing ------------------------------ */

/**
 * Pluggable text extractor — defaults to pdf-parse but can be stubbed
 * in tests with a fixture string.
 */
export type PdfTextExtractor = (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

export const defaultPdfExtractor: PdfTextExtractor = async (buffer) => {
  // unpdf is a modern serverless-friendly PDF text extractor. No DOM
  // APIs, no Node-specific filesystem hacks, runs cleanly on Vercel.
  // Returns one merged page text per page; we join with newlines and
  // also do per-line position-aware reconstruction so the BCBS-style
  // row parser sees plan IDs followed by their cells on the same line.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const uint8 = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(uint8);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return { text: pages.join("\n"), numpages: totalPages };
};

const NUMBER_RE = /\$?([\d,]+(?:\.\d+)?)/;
// Plan IDs in BCBS exhibits are 6-8 char codes like P9M1CHC, S9N1ADT,
// G9K8CHC. Pattern: starts with a letter, 5-7 alphanumerics following.
// We accept the token anywhere on a line (not just position 0) so the
// parser is robust to layout variations from different PDF extractors.
const PLAN_ID_RE = /^[A-Z][A-Z0-9]{5,7}$/;
const PLAN_ID_INLINE_RE = /\b[A-Z][A-Z0-9]{5,7}\b/;

function parseNumber(cell: string | undefined): number | null {
  if (!cell) return null;
  const trimmed = cell.trim();
  if (/not\s*covered/i.test(trimmed)) return null;
  if (/^DC/i.test(trimmed)) return null;
  const m = NUMBER_RE.exec(trimmed);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ""));
}

function detectMetalTier(line: string): MetalTier {
  const m = line.match(/\b(Platinum|Gold|Silver|Bronze)\b/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return (word.charAt(0).toUpperCase() + word.slice(1)) as MetalTier;
}

function detectNetwork(text: string): Network {
  if (/HMO/i.test(text)) return "HMO";
  if (/PPO/i.test(text)) return "PPO";
  if (/EPO/i.test(text)) return "EPO";
  if (/POS/i.test(text)) return "POS";
  return null;
}

/**
 * Extract plan rows from raw PDF text. The carrier renewal exhibit
 * (BCBS in this case) renders each plan as a row of cells separated by
 * whitespace; the parser walks lines, identifies anything starting with
 * a plan-id token (e.g. P9M1CHC, S9N1ADT), and pulls fields by position.
 *
 * Robust to partial cells (deductible can be "$1000// $2000" split
 * across two lines). The parser glues continuation lines back to the
 * row they belong to.
 */
export function extractPlanRows(rawText: string): {
  plans: BenefitPlan[];
  carrier: string | null;
  effective_date: string | null;
  account_number: string | null;
} {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Header sniffing
  let carrier: string | null = null;
  let account_number: string | null = null;
  let effective_date: string | null = null;
  for (const l of lines.slice(0, 80)) {
    if (/Blue Cross|Blue Shield/i.test(l)) carrier = "Blue Cross Blue Shield";
    else if (/Aetna/i.test(l)) carrier = "Aetna";
    else if (/Cigna/i.test(l)) carrier = "Cigna";
    else if (/UnitedHealth/i.test(l)) carrier = "UnitedHealthcare";
    else if (/Humana/i.test(l)) carrier = "Humana";
    const acctMatch = l.match(/Account Number[:\s]*([0-9]{4,})/i);
    if (acctMatch) account_number = acctMatch[1];
    const dateMatch = l.match(/Effective Date[:\s]*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i);
    if (dateMatch) effective_date = dateMatch[1];
  }

  // Track current network + metal tier from section headers
  let currentNetwork: Network = null;
  let currentTier: MetalTier = null;
  let currentIsHsa = false;

  const plans: BenefitPlan[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Section headers
    if (/Network$/i.test(line) && detectNetwork(line)) {
      currentNetwork = detectNetwork(line);
      continue;
    }
    if (/^HSA Plans?\*?$/i.test(line)) {
      currentIsHsa = true;
      continue;
    }
    if (/^(PPO|HMO|EPO|POS) Plans?$/i.test(line)) {
      const net = detectNetwork(line);
      if (net) currentNetwork = net;
      currentIsHsa = false;
      continue;
    }
    const tier = detectMetalTier(line);
    if (tier && line.length < 30) {
      currentTier = tier;
      continue;
    }

    // unpdf produces one cell per line for the BCBS exhibit format.
    // A plan row begins when we see a plan-id token alone on a line
    // (e.g. "P9M1CHC"). We then glue forward every line until the
    // next plan-id line, the next section header, or 30 lines
    // (whichever comes first) to reconstruct the full row.
    const trimmed = line.trim();
    if (!PLAN_ID_RE.test(trimmed) && !PLAN_ID_INLINE_RE.test(trimmed)) continue;
    const idMatch = trimmed.match(PLAN_ID_INLINE_RE);
    if (!idMatch) continue;
    const planId = idMatch[0];
    if (planId.length < 6) continue;

    // Include the plan-id line itself (it usually contains the first
    // deductible cell on the same line as the plan id)
    const bufferParts: string[] = [trimmed.replace(planId, "")];
    for (let j = 1; j <= 30; j++) {
      const next = lines[i + j];
      if (next === undefined) break;
      const nextTrimmed = next.trim();
      // Stop if we hit the next plan id (check the first token, since
      // the BCBS exhibit puts the first deductible cell on the same
      // line as the plan id, e.g. "S9N3ADT $4100//")
      const firstToken = nextTrimmed.split(/\s+/)[0] ?? "";
      if (PLAN_ID_RE.test(firstToken) && firstToken !== planId) break;
      // Stop on section headers
      if (/^(Platinum|Gold|Silver|Bronze)$/i.test(nextTrimmed)) break;
      if (/^(PPO|HMO|EPO|POS) Plans?$/i.test(nextTrimmed)) break;
      if (/^HSA Plans?\*?$/i.test(nextTrimmed)) break;
      if (/Network$/i.test(nextTrimmed) && detectNetwork(nextTrimmed)) break;
      bufferParts.push(nextTrimmed);
    }
    const buffer = bufferParts.join(" ");
    // Pull out every $-prefixed number from the buffer in order. The
    // BCBS exhibit always emits these in the same column order:
    //   ded_in, ded_out, oop_in, oop_out, [pcp $X/$X], [spec $X], er,
    //   urgent, in_ded_in, in_ded_out, [rx tier $X/$X/...], total_age,
    //   ee_only, ee_spouse, ee_child, ee_family, total_composite
    const numbers = buffer.match(/\$[\d,]+(?:\.\d+)?/g) ?? [];

    // Heuristics: typical row has [ded_in, ded_out, oop_in, oop_out, pcp,
    //   spec, er, urgent, in_ded, rx, total_age, ee_only, ee_spouse,
    //   ee_child, ee_family, total_composite]
    const cleanedNumbers = numbers.map((n) => parseFloat(n.replace(/[$,]/g, "")));

    // BCBS exhibit column order (from front of buffer):
    //   [0] individual deductible in-network
    //   [1] individual deductible out-of-network (may be missing if "Unlimited")
    //   [2] individual OOP max in-network
    //   [3] individual OOP max out-of-network (may be missing)
    // Then PCP, specialist, ER, urgent care, in-patient deductible,
    // 6 Rx copays, then the premium tail.
    //
    // To find OOP max reliably we look for the LARGEST four-or-five
    // figure number in the first 6 positions — deductibles are usually
    // 4 figures, OOP is usually 4-5 figures.
    const ded_in = cleanedNumbers[0] ?? null;
    // ded_out and oop_in are by definition both greater than ded_in.
    // Scan positions [1..5] for values strictly greater than ded_in
    // and below the premium cutoff (50K). The first such value is
    // ded_out; the second is oop_in. If only one is found (ded_out =
    // "Not Covered" was filtered), it's oop_in.
    let ded_out: number | null = null;
    let oop_in: number | null = null;
    if (ded_in !== null) {
      const candidates = cleanedNumbers
        .slice(1, 6)
        .filter((n) => n > ded_in && n < 50000);
      if (candidates.length >= 2) {
        ded_out = candidates[0];
        oop_in = candidates[1];
      } else if (candidates.length === 1) {
        oop_in = candidates[0];
      }
    }
    const oop_out = null;

    // Premiums: the LAST 5-6 numbers in the row are total_age + 4 splits
    // + total_composite. Total monthly premiums are typically the
    // largest values in the row (4-figure numbers).
    const tail = cleanedNumbers.slice(-6);
    const monthly_total_age = tail[0] ?? null;
    const ee_only = tail[1] ?? null;
    const ee_spouse = tail[2] ?? null;
    const ee_child = tail[3] ?? null;
    const ee_family = tail[4] ?? null;
    const monthly_total_composite = tail[5] ?? null;

    // PCP / specialist copays: parse cell-style "$0/$0" or "DC/DC"
    const cellRe = /(\$[\d,.]+|\bDC\b|\bNot Covered\b)\s*\/\s*(\$[\d,.]+|\bDC\b|\bNot Covered\b)/g;
    const cellMatches = [...buffer.matchAll(cellRe)];
    const pcp = cellMatches[0]?.[0] ?? "";
    const spec = cellMatches[1]?.[0] ?? "";
    const er = cellMatches[2]?.[0] ?? "";

    plans.push({
      plan_id: planId,
      plan_name: `${currentNetwork ?? ""} ${currentTier ?? ""}${currentIsHsa ? " HSA" : ""}`.trim() || undefined,
      network: currentNetwork,
      metal_tier: currentTier,
      is_hsa: currentIsHsa,
      individual_deductible_in_network: ded_in,
      individual_deductible_out_of_network: ded_out,
      individual_oop_max_in_network: oop_in,
      individual_oop_max_out_of_network: oop_out,
      primary_care_copay: pcp,
      primary_care_copay_in_network: parseNumber(pcp.split("/")[0]),
      specialist_copay: spec,
      specialist_copay_in_network: parseNumber(spec.split("/")[0]),
      er_copay: er,
      rx_copays: "",
      monthly_premium_age_employee_only: ee_only ?? monthly_total_age,
      monthly_premium_composite_employee_only: monthly_total_composite,
      monthly_premium_age_employee_spouse: ee_spouse,
      monthly_premium_age_employee_child: ee_child,
      monthly_premium_age_employee_family: ee_family,
      raw: { source_line: line },
    });
  }

  return { plans, carrier, effective_date, account_number };
}

export async function parseBenefitDocument(
  filename: string,
  buffer: Buffer,
  extractor: PdfTextExtractor = defaultPdfExtractor,
): Promise<BenefitDocument> {
  const { text, numpages } = await extractor(buffer);
  const { plans, carrier, effective_date, account_number } = extractPlanRows(text);
  return {
    filename,
    carrier,
    effective_date,
    account_number,
    page_count: numpages,
    size_bytes: buffer.length,
    raw_text_excerpt: text.slice(0, 2000),
    plans,
  };
}

/* ----------------------- Scoring engine ------------------------------- */

/**
 * "Cheapest practical" rule (the one Alicia uses for new-hire onboarding):
 *
 *   - MUST have $0 or low primary-care copay (covered without deductible)
 *   - MUST have a recoverable OOP max (not "unlimited", not >$10K)
 *   - MUST NOT be an HSA plan (HSAs make you pay the deductible first)
 *   - Among the survivors, pick the lowest monthly premium
 *
 * This codifies the recommendation we gave the user in chat. The brain
 * watches outcome (accepted/rejected) and can later learn which rules
 * are most predictive of acceptance.
 */
export function scoreCheapestPractical(plans: BenefitPlan[]): ScoredPlan[] {
  return plans
    .filter((p) => !p.is_hsa)
    .filter((p) => p.primary_care_copay_in_network !== null && p.primary_care_copay_in_network <= 25)
    .filter(
      (p) =>
        p.individual_oop_max_in_network !== null &&
        p.individual_oop_max_in_network > 0 &&
        p.individual_oop_max_in_network <= 10000,
    )
    .filter(
      (p) =>
        p.monthly_premium_age_employee_only !== null && p.monthly_premium_age_employee_only > 0,
    )
    .map((p) => {
      const premium = p.monthly_premium_age_employee_only ?? Infinity;
      const ded = p.individual_deductible_in_network ?? Infinity;
      const reasons: string[] = [];
      if (p.primary_care_copay_in_network === 0) reasons.push("$0 primary care");
      else if (p.primary_care_copay_in_network !== null && p.primary_care_copay_in_network <= 25)
        reasons.push(`Low PCP copay ($${p.primary_care_copay_in_network})`);
      reasons.push(`$${premium.toFixed(0)}/mo employee only`);
      reasons.push(`$${ded.toFixed(0)} deductible`);
      reasons.push(`$${(p.individual_oop_max_in_network ?? 0).toFixed(0)} OOP max`);
      // Lower is better. Premium dominates; deductible is a tiebreaker.
      const score = premium + ded * 0.05;
      return { plan: p, score, reasons };
    })
    .sort((a, b) => a.score - b.score);
}

export function scoreLowestPremium(plans: BenefitPlan[]): ScoredPlan[] {
  return plans
    .filter((p) => p.monthly_premium_age_employee_only && p.monthly_premium_age_employee_only > 0)
    .map((p) => ({
      plan: p,
      score: p.monthly_premium_age_employee_only ?? Infinity,
      reasons: [
        `$${p.monthly_premium_age_employee_only?.toFixed(0)}/mo`,
        p.is_hsa ? "HSA — high deductible exposure" : "Standard plan",
      ],
    }))
    .sort((a, b) => a.score - b.score);
}

export function scoreLowestTotalCost(plans: BenefitPlan[]): ScoredPlan[] {
  // Annual premium + half of deductible (assumes some healthcare usage)
  return plans
    .filter((p) => p.monthly_premium_age_employee_only && p.monthly_premium_age_employee_only > 0)
    .map((p) => {
      const annualPremium = (p.monthly_premium_age_employee_only ?? 0) * 12;
      const expectedDed = (p.individual_deductible_in_network ?? 0) * 0.5;
      const score = annualPremium + expectedDed;
      return {
        plan: p,
        score,
        reasons: [
          `$${annualPremium.toFixed(0)}/yr premium`,
          `$${expectedDed.toFixed(0)} expected deductible spend`,
          `Total: $${score.toFixed(0)}`,
        ],
      };
    })
    .sort((a, b) => a.score - b.score);
}

const RULE_RUNNERS: Record<ScoringRule, (plans: BenefitPlan[]) => ScoredPlan[]> = {
  cheapest_practical: scoreCheapestPractical,
  lowest_premium: scoreLowestPremium,
  lowest_total_cost: scoreLowestTotalCost,
  best_for_chronic_care: scoreCheapestPractical, // alias for v1
};

export function generateRecommendation(
  plans: BenefitPlan[],
  rule: ScoringRule = "cheapest_practical",
): Recommendation | null {
  const scored = RULE_RUNNERS[rule](plans);
  if (scored.length === 0) return null;
  const winner = scored[0];
  const runners = scored.slice(1, 4);
  const reasoning = `${winner.plan.plan_id} (${winner.plan.network} ${winner.plan.metal_tier}${winner.plan.is_hsa ? " HSA" : ""}) — ${winner.reasons.join(", ")}`;
  return {
    rule,
    plan: winner.plan,
    reasoning,
    score_breakdown: { winner_score: winner.score, scored_count: scored.length },
    runners_up: runners,
  };
}

/* ----------------------------- Persistence ----------------------------- */

export async function saveBenefitDocument(
  doc: BenefitDocument,
  uploadedBy: string,
  userRole: string,
): Promise<{ documentId: string; planIds: string[] }> {
  const documentId = `bd_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO apex_benefit_documents
       (id, filename, carrier, effective_date, account_number, page_count, size_bytes, raw_text_excerpt, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      documentId,
      doc.filename,
      doc.carrier,
      doc.effective_date,
      doc.account_number,
      doc.page_count,
      doc.size_bytes,
      doc.raw_text_excerpt,
      uploadedBy,
    ],
  );

  const planIds: string[] = [];
  for (const p of doc.plans) {
    const id = `bp_${randomUUID()}`;
    planIds.push(id);
    await safeQuery(
      `INSERT INTO apex_benefit_plans
         (id, document_id, plan_id, plan_name, network, metal_tier, is_hsa,
          individual_deductible_in_network, individual_deductible_out_of_network,
          individual_oop_max_in_network, individual_oop_max_out_of_network,
          primary_care_copay, primary_care_copay_in_network,
          specialist_copay, specialist_copay_in_network,
          er_copay, rx_copays,
          monthly_premium_age_employee_only, monthly_premium_composite_employee_only,
          monthly_premium_age_employee_spouse, monthly_premium_age_employee_child,
          monthly_premium_age_employee_family, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        id,
        documentId,
        p.plan_id,
        p.plan_name ?? null,
        p.network,
        p.metal_tier,
        p.is_hsa,
        p.individual_deductible_in_network,
        p.individual_deductible_out_of_network,
        p.individual_oop_max_in_network,
        p.individual_oop_max_out_of_network,
        p.primary_care_copay,
        p.primary_care_copay_in_network,
        p.specialist_copay,
        p.specialist_copay_in_network,
        p.er_copay,
        p.rx_copays,
        p.monthly_premium_age_employee_only,
        p.monthly_premium_composite_employee_only,
        p.monthly_premium_age_employee_spouse,
        p.monthly_premium_age_employee_child,
        p.monthly_premium_age_employee_family,
        JSON.stringify(p.raw),
      ],
    );
  }

  trackEvent("hr.benefit_document_parsed", uploadedBy, userRole, {
    document_id: documentId,
    plan_count: doc.plans.length,
    carrier: doc.carrier ?? "unknown",
  });

  return { documentId, planIds };
}

export async function saveRecommendation(
  rec: Recommendation,
  documentId: string,
  generatedBy: string,
  userRole: string,
): Promise<string> {
  const id = `br_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO apex_benefit_recommendations
       (id, document_id, rule_name, recommended_plan_id, reasoning, score_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, documentId, rec.rule, rec.plan.plan_id, rec.reasoning, JSON.stringify(rec.score_breakdown)],
  );
  trackEvent("hr.benefit_recommendation_generated", generatedBy, userRole, {
    document_id: documentId,
    recommendation_id: id,
    rule: rec.rule,
    recommended_plan: rec.plan.plan_id,
  });
  return id;
}

export async function decideRecommendation(
  recommendationId: string,
  outcome: "accepted" | "rejected" | "ignored",
  decidedBy: string,
  userRole: string,
): Promise<void> {
  await safeQuery(
    `UPDATE apex_benefit_recommendations
        SET outcome = $2, decided_by = $3, decided_at = NOW()
      WHERE id = $1`,
    [recommendationId, outcome, decidedBy],
  );
  trackEvent(
    outcome === "accepted" ? "hr.benefit_recommendation_accepted" : "hr.benefit_recommendation_rejected",
    decidedBy,
    userRole,
    { recommendation_id: recommendationId, outcome },
  );
}

export async function deleteBenefitDocument(
  id: string,
  deletedBy: string,
  userRole: string,
): Promise<boolean> {
  const r = await safeQuery(
    `DELETE FROM apex_benefit_documents WHERE id = $1 RETURNING id`,
    [id],
  );
  if (r.rows.length === 0) return false;
  // Cascade in the schema removes plans + recommendations automatically.
  trackEvent("hr.benefit_document_uploaded", deletedBy, userRole, {
    action: "deleted",
    document_id: id,
  });
  return true;
}

export async function listBenefitDocuments(): Promise<Array<Record<string, unknown>>> {
  const r = await safeQuery(
    `SELECT * FROM apex_benefit_documents ORDER BY uploaded_at DESC`,
  );
  return r.rows;
}

export async function getBenefitDocument(id: string): Promise<{
  document: Record<string, unknown> | null;
  plans: BenefitPlan[];
  recommendations: Array<Record<string, unknown>>;
}> {
  const docR = await safeQuery(
    `SELECT * FROM apex_benefit_documents WHERE id = $1`,
    [id],
  );
  if (docR.rows.length === 0) return { document: null, plans: [], recommendations: [] };
  const plansR = await safeQuery(
    `SELECT * FROM apex_benefit_plans WHERE document_id = $1 ORDER BY monthly_premium_age_employee_only ASC NULLS LAST`,
    [id],
  );
  const recsR = await safeQuery(
    `SELECT * FROM apex_benefit_recommendations WHERE document_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  // Postgres NUMERIC columns come back as strings via node-postgres by
  // default. Coerce them to real JS numbers so the client doesn't have
  // to defend against `.toFixed is not a function` crashes.
  const numericFields = [
    "individual_deductible_in_network",
    "individual_deductible_out_of_network",
    "individual_oop_max_in_network",
    "individual_oop_max_out_of_network",
    "primary_care_copay_in_network",
    "specialist_copay_in_network",
    "monthly_premium_age_employee_only",
    "monthly_premium_composite_employee_only",
    "monthly_premium_age_employee_spouse",
    "monthly_premium_age_employee_child",
    "monthly_premium_age_employee_family",
  ];
  const coercedPlans = plansR.rows.map((row) => {
    const out = { ...row } as Record<string, unknown>;
    for (const f of numericFields) {
      const v = out[f];
      if (v === null || v === undefined) continue;
      if (typeof v === "string") {
        const n = parseFloat(v);
        out[f] = Number.isFinite(n) ? n : null;
      }
    }
    return out;
  });
  return {
    document: docR.rows[0],
    plans: coercedPlans as unknown as BenefitPlan[],
    recommendations: recsR.rows,
  };
}

/* ----------------------------- Insights -------------------------------- */

export interface HrInsight {
  category: "benefits" | "onboarding" | "compliance";
  severity: "info" | "attention" | "critical";
  title: string;
  body: string;
  related_id?: string;
  source_rule: string;
}

/**
 * Generate insights from a parsed benefit document.
 *
 * Examples:
 *   - "Your cheapest HMO is $X cheaper than your cheapest PPO" (cost optimization)
 *   - "All HSA plans have OOP > $10K — high financial risk" (risk warning)
 *   - "Plans with $0 PCP copay average $Y less than plans with $25+ copay" (counterintuitive observation)
 */
export function generateBenefitInsights(plans: BenefitPlan[]): HrInsight[] {
  const insights: HrInsight[] = [];
  if (plans.length === 0) return insights;

  const ppos = plans.filter((p) => p.network === "PPO" && p.monthly_premium_age_employee_only);
  const hmos = plans.filter((p) => p.network === "HMO" && p.monthly_premium_age_employee_only);
  if (ppos.length > 0 && hmos.length > 0) {
    const cheapestPpo = Math.min(...ppos.map((p) => p.monthly_premium_age_employee_only ?? Infinity));
    const cheapestHmo = Math.min(...hmos.map((p) => p.monthly_premium_age_employee_only ?? Infinity));
    if (cheapestPpo > cheapestHmo) {
      const diff = cheapestPpo - cheapestHmo;
      insights.push({
        category: "benefits",
        severity: "info",
        title: `HMO is $${diff.toFixed(0)}/mo cheaper than PPO`,
        body: `Your cheapest HMO ($${cheapestHmo.toFixed(0)}/mo) beats your cheapest PPO ($${cheapestPpo.toFixed(0)}/mo) by $${diff.toFixed(0)}/mo per employee, or $${(diff * 12).toFixed(0)}/yr. Worth recommending HMO unless team members have specific out-of-network specialists.`,
        source_rule: "ppo_vs_hmo_cost_gap",
      });
    }
  }

  const hsas = plans.filter((p) => p.is_hsa);
  if (hsas.length > 0) {
    const avgOop =
      hsas.reduce((s, p) => s + (p.individual_oop_max_in_network ?? 0), 0) / hsas.length;
    insights.push({
      category: "benefits",
      severity: "attention",
      title: `${hsas.length} HSA plans on this renewal — high deductible exposure`,
      body: `${hsas.length} HSA plan${hsas.length > 1 ? "s" : ""} with average out-of-pocket max of $${avgOop.toFixed(0)}. HSA plans require you to pay the full deductible before coinsurance kicks in. They only make sense for employees who can absorb a worst-case year and want the tax-advantaged savings. Default to non-HSA Silver/Gold for the rest.`,
      source_rule: "hsa_warning",
    });
  }

  const lowCopay = plans.filter((p) => p.primary_care_copay_in_network === 0);
  if (lowCopay.length > 0 && plans.length - lowCopay.length > 0) {
    const lowAvg = lowCopay.reduce((s, p) => s + (p.monthly_premium_age_employee_only ?? 0), 0) / lowCopay.length;
    insights.push({
      category: "benefits",
      severity: "info",
      title: `${lowCopay.length} plans offer $0 primary care visits`,
      body: `${lowCopay.length} of ${plans.length} plans have $0 primary care copay (covered without meeting deductible). Average premium for these: $${lowAvg.toFixed(0)}/mo. These are typically the strongest "cheapest practical" candidates for new hires.`,
      source_rule: "zero_pcp_copay_callout",
    });
  }

  return insights;
}

export async function saveInsights(insights: HrInsight[], generatedBy: string, userRole: string): Promise<void> {
  for (const ins of insights) {
    const id = `hi_${randomUUID()}`;
    await safeQuery(
      `INSERT INTO apex_hr_insights (id, category, severity, title, body, related_id, source_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ins.category, ins.severity, ins.title, ins.body, ins.related_id ?? null, ins.source_rule],
    );
    trackEvent("hr.insight_generated", generatedBy, userRole, {
      insight_id: id,
      category: ins.category,
      severity: ins.severity,
      source_rule: ins.source_rule,
    });
  }
}

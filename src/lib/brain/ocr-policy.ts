/**
 * How to read a document that has no extractable text, and what it costs.
 *
 * SIXTY-TWO scanned PDFs and FORTY-THREE images sit in the Brain with no text.
 * Together they are a third of everything the library cannot answer. They need
 * OCR, and OCR is the first thing in this product that spends real money per
 * document rather than per question, so it is the first that needs a policy
 * rather than a call site.
 *
 * THE EFFICIENCY ARGUMENT, which is the whole reason this file is not just a
 * call to a vision model. A vision-capable LLM will read a scanned page, and
 * it costs one to two orders of magnitude more per page than a dedicated OCR
 * API that does exactly one job. Sending a hundred scanned pages through a
 * vision model because it was the easiest thing to import is how a fixed
 * ingestion cost becomes a per-document bill nobody predicted. The model
 * router already learned this the expensive way: with both Azure models
 * configured it served 0% from the cheap tier for months, because its only
 * caller asked for `large` unconditionally. A cost-aware system whose caller
 * hardcodes the expensive path is cost-aware in name only.
 *
 * So: cheapest capable route first, escalate only on a specific failure, and
 * never escalate silently.
 *
 *   1. vision_api    Azure Computer Vision. Purpose-built, cheap per page,
 *                    handles printed text and most scans.
 *   2. vision_model  A vision-capable model through the router. Reserved for
 *                    what the OCR API explicitly could not read: handwriting,
 *                    tables that need layout understanding, a page it refused.
 *                    Costs meaningfully more, so it is a fallback and never a
 *                    default.
 *   3. none          Nothing can read it, said plainly, so the document stops
 *                    being retried forever.
 *
 * PURE. No I/O, no clients, no env reads beyond the capability flags handed
 * in, so the policy can be argued with and changed without touching whatever
 * executes it. Same split as tier-for-task.ts, for the same reason.
 */

import type { BrainKind } from "./types";

export type OcrRoute = "vision_api" | "vision_model" | "none";

export interface OcrCapabilities {
  /** Azure Computer Vision is configured and reachable. */
  visionApi: boolean;
  /** A vision-capable model is available through the router. */
  visionModel: boolean;
}

export interface OcrDecision {
  route: OcrRoute;
  /** One line an operator can read on a cost page to tell a deliberate
   *  escalation from a bug. */
  reason: string;
  /** Rough cents per page, so a run can be costed BEFORE it is authorised.
   *  Null when nothing will run. Deliberately an estimate: the point is the
   *  order of magnitude between the two routes, not two decimal places. */
  estimatedCentsPerPage: number | null;
  /** True when this route sends document content to a model provider, which
   *  is a residency and redaction question rather than only a cost one. */
  leavesTenant: boolean;
}

/**
 * Order-of-magnitude costs. Exact prices move; the RATIO is the decision, and
 * the ratio has been stable across every provider: a dedicated OCR API is
 * cents per hundred pages, a vision model is cents per page.
 */
export const VISION_API_CENTS_PER_PAGE = 0.1;
export const VISION_MODEL_CENTS_PER_PAGE = 3;

/** Kinds where "no extractable text" means a scan rather than an empty file. */
const OCR_ABLE: ReadonlySet<string> = new Set<BrainKind>(["pdf", "image"]);

/** The failure that means the cheap route genuinely could not read the page. */
const ESCALATABLE = /handwrit|low.confidence|unreadable|no recognizable text|layout/i;

export interface OcrContext {
  kind: BrainKind;
  /** Why the sync extractor gave up, if it said. */
  failureDetail?: string | null;
  /** A route already tried and failed for this document. */
  alreadyTried?: OcrRoute | null;
}

/**
 * Pick the route.
 *
 * NEVER escalates to the model on the first attempt. A page that the OCR API
 * has not yet been asked about is not a page the OCR API failed on, and
 * treating the two the same is how the expensive path becomes the default.
 */
export function decideOcrRoute(ctx: OcrContext, caps: OcrCapabilities): OcrDecision {
  if (!OCR_ABLE.has(ctx.kind)) {
    return {
      route: "none",
      reason: `${ctx.kind} is not a scanned format; OCR would not help`,
      estimatedCentsPerPage: null,
      leavesTenant: false,
    };
  }

  /* FIRST ATTEMPT: the cheap, purpose-built route, whenever it exists. */
  if (!ctx.alreadyTried && caps.visionApi) {
    return {
      route: "vision_api",
      reason: "purpose-built OCR, roughly thirty times cheaper per page than a vision model",
      estimatedCentsPerPage: VISION_API_CENTS_PER_PAGE,
      leavesTenant: false,
    };
  }

  /* ESCALATION: only after the cheap route was asked and said it could not. */
  if (ctx.alreadyTried === "vision_api") {
    if (!caps.visionModel) {
      return {
        route: "none",
        reason: "the OCR API could not read it and no vision model is configured to escalate to",
        estimatedCentsPerPage: null,
        leavesTenant: false,
      };
    }
    if (!ESCALATABLE.test(ctx.failureDetail ?? "")) {
      /* A page that failed for being too large, or corrupt, will fail the same
         way on a model. Paying thirty times more to be told so twice is the
         cost of an escalation rule that never says no. */
      return {
        route: "none",
        reason: `the OCR API failed for a reason a model cannot fix: ${ctx.failureDetail ?? "unknown"}`,
        estimatedCentsPerPage: null,
        leavesTenant: false,
      };
    }
    return {
      route: "vision_model",
      reason: "the OCR API reported it could not read the page, which is what a vision model is for",
      estimatedCentsPerPage: VISION_MODEL_CENTS_PER_PAGE,
      leavesTenant: true,
    };
  }

  /* No cheap route configured. The model is allowed, but as a deliberate
     choice that says so, not as a silent default. */
  if (caps.visionModel) {
    return {
      route: "vision_model",
      reason: "no OCR API is configured, so the vision model is the only route; configuring Vision would cut this cost sharply",
      estimatedCentsPerPage: VISION_MODEL_CENTS_PER_PAGE,
      leavesTenant: true,
    };
  }

  return {
    route: "none",
    reason: "no OCR route is configured, so this document cannot be read",
    estimatedCentsPerPage: null,
    leavesTenant: false,
  };
}

export interface OcrBudgetInput {
  pages: number;
  decision: OcrDecision;
  /** Cents this workspace may spend on a single OCR run. */
  ceilingCents: number;
}

export interface OcrBudgetVerdict {
  allowed: boolean;
  estimatedCents: number | null;
  reason: string;
}

/**
 * Would this run fit the ceiling.
 *
 * COSTED BEFORE IT IS AUTHORISED, not after. An ingestion job that discovers
 * its own bill by running is the shape that makes a per-document cost
 * frightening, and it is why this returns a refusal rather than a warning.
 */
export function withinOcrBudget(input: OcrBudgetInput): OcrBudgetVerdict {
  const { pages, decision, ceilingCents } = input;
  if (decision.route === "none" || decision.estimatedCentsPerPage === null) {
    return { allowed: false, estimatedCents: null, reason: decision.reason };
  }
  if (pages <= 0) {
    return { allowed: false, estimatedCents: 0, reason: "nothing to read" };
  }
  const estimatedCents = Number((pages * decision.estimatedCentsPerPage).toFixed(2));
  if (estimatedCents > ceilingCents) {
    return {
      allowed: false,
      estimatedCents,
      /* Names the number and the ceiling, because "over budget" alone leaves
         somebody guessing whether to raise the ceiling or split the run. */
      reason: `estimated ${estimatedCents}c exceeds the ${ceilingCents}c ceiling for one run; raise the ceiling or reduce the batch`,
    };
  }
  return {
    allowed: true,
    estimatedCents,
    reason: `${pages} page${pages === 1 ? "" : "s"} via ${decision.route}, about ${estimatedCents}c`,
  };
}

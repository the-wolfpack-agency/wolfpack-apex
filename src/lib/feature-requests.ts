/**
 * Feature Request Library — Zero-token analysis, voting, pipeline management.
 *
 * Every feature request gets automatic complexity/cost estimation
 * without burning AI tokens. Keyword pattern matching + heuristics.
 */

import { query, safeQuery, writeQuery, WriteQueryError } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type FeatureStatus = "submitted" | "analyzing" | "approved" | "rejected" | "in_progress" | "completed";
export type FeaturePriority = "low" | "medium" | "high" | "critical";
export type Complexity = "low" | "medium" | "high" | "very_high";

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  submitted_by: string;
  status: FeatureStatus;
  priority: FeaturePriority;
  target_product: string | null;
  analysis: Record<string, unknown>;
  comparisons: unknown[];
  votes: number;
  comments: unknown[];
  estimated_hours: number | null;
  estimated_cost: number | null;
  created_at: string;
  updated_at: string;
}

export interface FeatureAnalysis {
  complexity: Complexity;
  estimated_hours_min: number;
  estimated_hours_max: number;
  estimated_cost_min: number;
  estimated_cost_max: number;
  keywords_matched: string[];
  similar_features: Array<{ id: string; title: string; similarity: string }>;
  risk_factors: string[];
  recommendation: string;
}

export interface PipelineEntry {
  status: string;
  count: number;
  avg_hours: number | null;
  avg_cost: number | null;
  total_votes: number;
}

const HOURLY_RATE = 150;

const COMPLEXITY_HOURS: Record<Complexity, [number, number]> = {
  low: [4, 8],
  medium: [16, 40],
  high: [40, 80],
  very_high: [80, 200],
};

// Keyword patterns for zero-token complexity estimation
const HIGH_COMPLEXITY_KEYWORDS = [
  "database", "migration", "schema", "authentication", "oauth", "sso",
  "payment", "stripe", "billing", "real-time", "websocket", "streaming",
  "machine learning", "ml", "ai model", "training", "kubernetes", "k8s",
  "distributed", "microservice", "multi-tenant", "rbac", "encryption",
];

const MEDIUM_COMPLEXITY_KEYWORDS = [
  "api", "endpoint", "integration", "webhook", "notification", "email",
  "dashboard", "chart", "report", "export", "import", "csv", "pdf",
  "search", "filter", "pagination", "caching", "queue", "workflow",
  "form", "validation", "upload", "file", "image",
];

const RISK_KEYWORDS: Record<string, string> = {
  "breaking change": "May require migration path for existing users",
  "security": "Requires security review before deployment",
  "performance": "Needs load testing and benchmarking",
  "third-party": "External dependency introduces availability risk",
  "data migration": "Requires careful rollback strategy",
  "multi-tenant": "Must verify tenant isolation",
};

function estimateComplexity(title: string, description: string): { complexity: Complexity; keywords: string[] } {
  const text = `${title} ${description}`.toLowerCase();
  const matched: string[] = [];

  let highCount = 0;
  for (const kw of HIGH_COMPLEXITY_KEYWORDS) {
    if (text.includes(kw)) {
      highCount++;
      matched.push(kw);
    }
  }

  let medCount = 0;
  for (const kw of MEDIUM_COMPLEXITY_KEYWORDS) {
    if (text.includes(kw)) {
      medCount++;
      matched.push(kw);
    }
  }

  // Word count as a rough scope indicator
  const wordCount = description.split(/\s+/).length;

  let complexity: Complexity;
  if (highCount >= 3 || (highCount >= 2 && wordCount > 200)) {
    complexity = "very_high";
  } else if (highCount >= 1 || (medCount >= 3 && wordCount > 100)) {
    complexity = "high";
  } else if (medCount >= 1 || wordCount > 50) {
    complexity = "medium";
  } else {
    complexity = "low";
  }

  return { complexity, keywords: matched };
}

function detectRisks(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const risks: string[] = [];
  for (const [keyword, risk] of Object.entries(RISK_KEYWORDS)) {
    if (text.includes(keyword)) {
      risks.push(risk);
    }
  }
  return risks;
}

/**
 * Submit a new feature request.
 */
export async function submitFeatureRequest(
  title: string,
  description: string,
  userId: string,
  targetProduct?: string,
  priority?: FeaturePriority,
): Promise<FeatureRequest | null> {
  // If DATABASE_URL is unset we're in shadow/dev mode — return a demo
  // row upfront. This is the ONLY branch where a "success" response
  // without a real DB write is acceptable, and it's gated by the
  // absence of DATABASE_URL so production can never fall into it.
  if (!process.env.DATABASE_URL) {
    const demo: FeatureRequest = {
      id: `demo-fr-${Date.now()}`,
      title,
      description,
      submitted_by: userId,
      status: "submitted",
      priority: priority || "medium",
      target_product: targetProduct || null,
      analysis: {},
      comparisons: [],
      votes: 0,
      comments: [],
      estimated_hours: null,
      estimated_cost: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return demo;
  }

  // Real database path: writeQuery THROWS on any failure (pg error,
  // view-propagation drop, RLS discard, etc.) so a non-throwing call
  // here is a guarantee that the row is actually committed. The
  // expectRows: 1 check catches the silent-discard case — a "succeeded"
  // INSERT that returns zero rows, which is what an auto-updatable
  // view would do if the rewriter rejected the write. End-to-end
  // verification of the full round-trip happens in
  // tests/e2e/feature-requests-data-flow.spec.ts (creates, reads back
  // via a separate request, asserts equality — the reality check that
  // mocks can't fake).
  try {
    const { rows } = await writeQuery<FeatureRequest>(
      `INSERT INTO instinct_feature_requests (title, description, submitted_by, target_product, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, description, userId, targetProduct || null, priority || "medium"],
      { expectRows: 1 },
    );
    trackEvent("feature.request_submitted", userId, "unknown", {
      feature_id: rows[0].id,
      title,
      target_product: targetProduct || "",
      priority: priority || "medium",
    });
    return rows[0];
  } catch (err) {
    if (err instanceof WriteQueryError) {
      trackEvent("feature.request_write_failed", userId, "unknown", {
        reason: err.code,
        expected: err.expected ?? -1,
        actual: err.actual ?? -1,
        title,
      });
    }
    throw err;
  }
}

/**
 * Zero-token analysis: estimate complexity, cost, find similar features.
 */
export async function analyzeFeatureRequest(requestId: string): Promise<FeatureAnalysis | null> {
  // Fetch the request
  const { rows } = await safeQuery<FeatureRequest>(
    `SELECT * FROM instinct_feature_requests WHERE id = $1`,
    [requestId],
  );

  const request = rows[0];
  if (!request) return null;

  const { complexity, keywords } = estimateComplexity(request.title, request.description);
  const [hoursMin, hoursMax] = COMPLEXITY_HOURS[complexity];
  const risks = detectRisks(request.title, request.description);

  // Search for similar existing features
  const { rows: similar } = await safeQuery<{ id: string; title: string; similarity: string }>(
    `SELECT id, title,
       CASE
         WHEN similarity(title, $1) > 0.5 THEN 'high'
         WHEN similarity(title, $1) > 0.3 THEN 'medium'
         ELSE 'low'
       END AS similarity
     FROM instinct_feature_requests
     WHERE id != $2 AND similarity(title, $1) > 0.2
     ORDER BY similarity(title, $1) DESC
     LIMIT 5`,
    [request.title, requestId],
  );

  const midHours = (hoursMin + hoursMax) / 2;

  const analysis: FeatureAnalysis = {
    complexity,
    estimated_hours_min: hoursMin,
    estimated_hours_max: hoursMax,
    estimated_cost_min: hoursMin * HOURLY_RATE,
    estimated_cost_max: hoursMax * HOURLY_RATE,
    keywords_matched: keywords,
    similar_features: similar,
    risk_factors: risks,
    recommendation: risks.length > 2
      ? "High risk — requires detailed technical review before approval"
      : complexity === "very_high"
        ? "Very high complexity — consider breaking into smaller deliverables"
        : complexity === "high"
          ? "Significant effort — recommend prototyping phase first"
          : "Feasible within standard sprint cycle",
  };

  // Store analysis back on the record
  await safeQuery(
    `UPDATE instinct_feature_requests
     SET analysis = $1, estimated_hours = $2, estimated_cost = $3, status = 'analyzing', updated_at = NOW()
     WHERE id = $4`,
    [JSON.stringify(analysis), midHours, midHours * HOURLY_RATE, requestId],
  );

  trackEvent("feature.request_analyzed", request.submitted_by, "unknown", {
    feature_id: requestId,
    complexity,
    estimated_hours: midHours,
    estimated_cost: midHours * HOURLY_RATE,
  });

  return analysis;
}

/**
 * Vote on a feature request. One vote per call (dedup in UI layer).
 */
export async function voteOnFeature(requestId: string, userId: string): Promise<number> {
  const { rows } = await safeQuery<{ votes: number }>(
    `UPDATE instinct_feature_requests
     SET votes = votes + 1, updated_at = NOW()
     WHERE id = $1
     RETURNING votes`,
    [requestId],
  );

  const newVotes = rows[0]?.votes ?? 1;
  trackEvent("feature.request_submitted", userId, "unknown", {
    feature_id: requestId,
    action: "vote",
    new_count: newVotes,
  });
  return newVotes;
}

/**
 * Update feature status with analytics tracking.
 */
export async function updateFeatureStatus(
  requestId: string,
  status: FeatureStatus,
  userId: string,
): Promise<FeatureRequest | null> {
  const { rows } = await safeQuery<FeatureRequest>(
    `UPDATE instinct_feature_requests
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [status, requestId],
  );

  if (rows.length > 0) {
    const eventMap: Partial<Record<FeatureStatus, "feature.request_approved" | "feature.request_rejected">> = {
      approved: "feature.request_approved",
      rejected: "feature.request_rejected",
    };
    const event = eventMap[status];
    if (event) {
      trackEvent(event, userId, "unknown", { feature_id: requestId, new_status: status });
    }
    return rows[0];
  }
  return null;
}

/**
 * Update an existing feature request (title / description / priority /
 * target_product). Separate from updateFeatureStatus — this is the
 * content-edit path used by owners and admins from the /features UI.
 *
 * Returns null when the id doesn't match a row so the route layer can
 * send a 404. Authorization is enforced by the caller (owner or admin);
 * this library function is intentionally permissive so jobs / migrations
 * can reuse it.
 */
export interface FeatureUpdate {
  title?: string;
  description?: string;
  priority?: FeaturePriority;
  target_product?: string | null;
}

export async function updateFeatureRequest(
  id: string,
  updates: FeatureUpdate,
  userId: string,
): Promise<FeatureRequest | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${idx++}`);
    params.push(updates.title);
  }
  if (updates.description !== undefined) {
    setClauses.push(`description = $${idx++}`);
    params.push(updates.description);
  }
  if (updates.priority !== undefined) {
    setClauses.push(`priority = $${idx++}`);
    params.push(updates.priority);
  }
  if (updates.target_product !== undefined) {
    setClauses.push(`target_product = $${idx++}`);
    params.push(updates.target_product);
  }

  if (setClauses.length === 0) return null;

  setClauses.push("updated_at = NOW()");
  params.push(id);

  if (!process.env.DATABASE_URL) {
    trackEvent("features.edited", userId, "unknown", {
      feature_id: id,
      fields: Object.keys(updates).join(","),
    });
    const demo: FeatureRequest = {
      id,
      title: updates.title ?? "demo title",
      description: updates.description ?? "demo description",
      submitted_by: userId,
      status: "submitted",
      priority: updates.priority ?? "medium",
      target_product: updates.target_product ?? null,
      analysis: {},
      comparisons: [],
      votes: 0,
      comments: [],
      estimated_hours: null,
      estimated_cost: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return demo;
  }

  const { rows } = await safeQuery<FeatureRequest>(
    `UPDATE instinct_feature_requests
        SET ${setClauses.join(", ")}
      WHERE id = $${idx}
      RETURNING *`,
    params,
  );
  if (rows.length === 0) return null;
  trackEvent("features.edited", userId, "unknown", {
    feature_id: id,
    fields: Object.keys(updates).join(","),
  });
  return rows[0];
}

/**
 * Delete a feature request. Hard delete — instinct_feature_requests has
 * no soft-delete column yet. Fires `features.deleted`. Returns true when
 * a row was removed.
 */
export async function deleteFeatureRequest(
  id: string,
  userId: string,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    trackEvent("features.deleted", userId, "unknown", { feature_id: id });
    return true;
  }
  const result = await safeQuery(
    `DELETE FROM instinct_feature_requests WHERE id = $1`,
    [id],
  );
  const affected = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  if (affected > 0) {
    trackEvent("features.deleted", userId, "unknown", { feature_id: id });
    return true;
  }
  return false;
}

/**
 * Load a single feature request (used by route-level ownership checks so
 * we don't need to duplicate the SELECT * pattern in every caller).
 */
export async function getFeatureRequest(
  id: string,
): Promise<FeatureRequest | null> {
  const { rows } = await safeQuery<FeatureRequest>(
    `SELECT * FROM instinct_feature_requests WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * List feature requests with optional filters.
 */
export async function getFeatureRequests(
  status?: FeatureStatus,
  targetProduct?: string,
): Promise<FeatureRequest[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`status = $${idx++}`);
    params.push(status);
  }
  if (targetProduct) {
    conditions.push(`target_product = $${idx++}`);
    params.push(targetProduct);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await safeQuery<FeatureRequest>(
    `SELECT * FROM instinct_feature_requests ${where} ORDER BY created_at DESC`,
    params,
  );
  return rows;
}

/**
 * Get the feature pipeline aggregation.
 */
export async function getFeaturePipeline(): Promise<PipelineEntry[]> {
  const { rows } = await safeQuery<PipelineEntry>(
    `SELECT * FROM v_feature_pipeline ORDER BY count DESC`,
  );
  return rows;
}

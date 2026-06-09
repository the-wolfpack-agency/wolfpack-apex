/**
 * Survey persistence — CRUD over instinct_surveys + instinct_survey_responses.
 *
 * Postgres is the source of truth. Routes stay thin: validation lives in
 * ./validate (pure), persistence lives here, analytics/audit fire from the
 * route. Slug generation retries on collision like the QR module.
 */

import { writeQuery, safeQuery } from "@/lib/db";
import { generateSurveySlug, validateSchema } from "./validate";
import type {
  AnswerMap,
  Survey,
  SurveyResponse,
  SurveySchema,
  SurveyStatus,
} from "./types";

interface SurveyRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  schema: SurveySchema;
  status: SurveyStatus;
  qr_code_id: string | null;
  client_id: string | null;
  created_by_user_id: string | null;
  created_by_user_role: string | null;
  created_at: string;
  updated_at: string;
}

interface ResponseRow {
  id: string;
  survey_id: string;
  answers: AnswerMap;
  respondent_fingerprint: string | null;
  qr_scan_id: string | null;
  submitted_at: string;
}

const SURVEY_COLS =
  "id, slug, title, description, schema, status, qr_code_id, client_id, " +
  "created_by_user_id, created_by_user_role, created_at, updated_at";

function rowToSurvey(r: SurveyRow): Survey {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    schema: r.schema ?? { questions: [] },
    status: r.status,
    qrCodeId: r.qr_code_id,
    clientId: r.client_id,
    createdByUserId: r.created_by_user_id,
    createdByUserRole: r.created_by_user_role,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToResponse(r: ResponseRow): SurveyResponse {
  return {
    id: r.id,
    surveyId: r.survey_id,
    answers: r.answers ?? {},
    respondentFingerprint: r.respondent_fingerprint,
    qrScanId: r.qr_scan_id,
    submittedAt: r.submitted_at,
  };
}

export async function createSurvey(args: {
  title: string;
  description?: string | null;
  schema: SurveySchema;
  clientId?: string | null;
  userId: string;
  userRole: string;
}): Promise<Survey> {
  if (!args.title || !args.title.trim()) throw new Error("title is required");
  const schemaCheck = validateSchema(args.schema);
  if (!schemaCheck.ok) throw new Error(schemaCheck.error);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = generateSurveySlug();
    try {
      const result = await writeQuery<SurveyRow>(
        `INSERT INTO instinct_surveys
           (slug, title, description, schema, status, client_id,
            created_by_user_id, created_by_user_role)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
         RETURNING ${SURVEY_COLS}`,
        [
          slug,
          args.title.trim(),
          args.description ?? null,
          JSON.stringify(args.schema),
          args.clientId ?? null,
          args.userId,
          args.userRole,
        ],
        { expectRows: 1 },
      );
      return rowToSurvey(result.rows[0]);
    } catch (err) {
      lastErr = err;
      if (!/duplicate|unique|23505/i.test((err as Error).message ?? "")) throw err;
    }
  }
  throw new Error(
    `[surveys] Failed to generate unique slug: ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

export async function listSurveys(opts?: {
  userId?: string;
  limit?: number;
}): Promise<Survey[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const params: unknown[] = [];
  let where = "";
  if (opts?.userId) {
    params.push(opts.userId);
    where = `WHERE created_by_user_id = $${params.length}`;
  }
  params.push(limit);
  const result = await safeQuery<SurveyRow>(
    `SELECT ${SURVEY_COLS} FROM instinct_surveys ${where}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToSurvey);
}

export async function getSurveyById(id: string): Promise<Survey | null> {
  if (!id) return null;
  const result = await safeQuery<SurveyRow>(
    `SELECT ${SURVEY_COLS} FROM instinct_surveys WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? rowToSurvey(result.rows[0]) : null;
}

/** Public lookup — only ever returns a PUBLISHED survey. */
export async function getPublishedSurveyBySlug(slug: string): Promise<Survey | null> {
  if (!slug) return null;
  const result = await safeQuery<SurveyRow>(
    `SELECT ${SURVEY_COLS} FROM instinct_surveys
      WHERE slug = $1 AND status = 'published' LIMIT 1`,
    [slug],
  );
  return result.rows[0] ? rowToSurvey(result.rows[0]) : null;
}

export async function updateSurvey(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    schema?: SurveySchema;
    status?: SurveyStatus;
    qrCodeId?: string | null;
  },
): Promise<Survey> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error("title is required");
    params.push(patch.title.trim());
    sets.push(`title = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  if (patch.schema !== undefined) {
    const check = validateSchema(patch.schema);
    if (!check.ok) throw new Error(check.error);
    params.push(JSON.stringify(patch.schema));
    sets.push(`schema = $${params.length}`);
  }
  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }
  if (patch.qrCodeId !== undefined) {
    params.push(patch.qrCodeId);
    sets.push(`qr_code_id = $${params.length}`);
  }
  if (sets.length === 0) throw new Error("updateSurvey: patch is empty");
  sets.push("updated_at = NOW()");
  params.push(id);
  const result = await writeQuery<SurveyRow>(
    `UPDATE instinct_surveys SET ${sets.join(", ")}
      WHERE id = $${params.length} RETURNING ${SURVEY_COLS}`,
    params,
    { expectRows: 1 },
  );
  return rowToSurvey(result.rows[0]);
}

export async function deleteSurvey(id: string): Promise<void> {
  await writeQuery(`DELETE FROM instinct_surveys WHERE id = $1`, [id]);
}

export async function submitResponse(args: {
  surveyId: string;
  answers: AnswerMap;
  respondentFingerprint?: string | null;
  qrScanId?: string | null;
}): Promise<SurveyResponse> {
  const result = await writeQuery<ResponseRow>(
    `INSERT INTO instinct_survey_responses
       (survey_id, answers, respondent_fingerprint, qr_scan_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, survey_id, answers, respondent_fingerprint, qr_scan_id, submitted_at`,
    [
      args.surveyId,
      JSON.stringify(args.answers),
      args.respondentFingerprint ?? null,
      args.qrScanId ?? null,
    ],
    { expectRows: 1 },
  );
  return rowToResponse(result.rows[0]);
}

export async function listResponses(
  surveyId: string,
  limit = 1000,
): Promise<SurveyResponse[]> {
  const result = await safeQuery<ResponseRow>(
    `SELECT id, survey_id, answers, respondent_fingerprint, qr_scan_id, submitted_at
       FROM instinct_survey_responses
      WHERE survey_id = $1
      ORDER BY submitted_at DESC
      LIMIT $2`,
    [surveyId, Math.max(1, Math.min(limit, 5000))],
  );
  return result.rows.map(rowToResponse);
}

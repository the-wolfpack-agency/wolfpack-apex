/**
 * Org-wide learning loop for the Wolfpack Assistant.
 *
 * When a wolfpack member follows up on an assistant answer with a
 * correction ("no, it is Porsche", "actually, the owner is Jorge"),
 * we capture that correction as a structured fact in
 * `instinct_org_facts` so every future prompt across the team is
 * grounded with it.
 *
 * The loop is intentionally simple:
 *
 *   detectCorrection(userText)
 *     → returns { attribute, value } when the user message looks like
 *       a correction. Heuristic regex; no LLM.
 *
 *   captureFactFromCorrection({ priorAssistantContent, ... })
 *     → INSERT into instinct_org_facts with subject inferred from the
 *       most prominent named entity in the prior assistant answer.
 *
 *   findRelevantFacts(question)
 *     → SELECT facts whose subject_normalized appears as a substring of
 *       the question (case-insensitive). Used to inject ground-truth
 *       lines into the LLM system prompt before each call.
 *
 * Zero LLM tokens for any of these — all detection is regex/SQL.
 */

import { safeQuery } from "@/lib/db";

export interface OrgFact {
  id: string;
  subject: string;
  attribute: string;
  value: string;
}

export interface CorrectionExtraction {
  attribute: string;
  value: string;
}

/* ------------------------------------------------------------------ */
/* Safety: role allowlist, value sanitization, rate limit              */
/* ------------------------------------------------------------------ */

/* Roles permitted to write into the org-wide fact store. Membership in
   this set is enforced before any INSERT — even an authenticated user
   without an allowed role cannot poison the learning loop. */
const ALLOWED_FACT_ROLES = new Set<string>([
  "admin",
  "owner",
  "cto",
  "ceo",
  "lead",
  "manager",
  "member",
]);

/* Per-user write budget. Above this rate, captures are silently dropped
   for the rest of the hour. Prevents rapid-fire poisoning. */
const FACT_RATE_LIMIT_PER_HOUR = 20;

const FACT_VALUE_MAX_LEN = 500;
const FACT_ATTRIBUTE_MAX_LEN = 80;

/**
 * Neutralize a value before it is stored or rendered into an LLM
 * grounding block. Strips line breaks, control characters, and caps
 * length. The combination defeats the canonical persistent-prompt-
 * injection payload (a multi-line value that closes the grounding
 * fence and starts a new "system:" instruction).
 */
export function sanitizeFactValue(s: string): string {
  if (!s) return "";
  return s
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FACT_VALUE_MAX_LEN);
}

function sanitizeFactAttribute(s: string): string {
  if (!s) return "fact";
  const clean = s
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .slice(0, FACT_ATTRIBUTE_MAX_LEN);
  return clean || "fact";
}

/**
 * Reject patterns that look like attempts to override the LLM's
 * system prompt at render time. Defense-in-depth alongside
 * sanitization — if a payload survives the strip, an obvious
 * prompt-injection cue still fails the allowlist.
 */
export function isAllowedFactValue(s: string): boolean {
  if (!s || s.length === 0) return false;
  if (s.length > FACT_VALUE_MAX_LEN) return false;
  if (/\bignore (?:prior|previous|above|the\s+above)\b/i.test(s)) return false;
  if (/\b(?:system|assistant)\s*:\s*you are\b/i.test(s)) return false;
  if (/<\|im_(?:start|end)\|>/i.test(s)) return false;
  return true;
}

/**
 * Per-user-per-hour rate limit on fact writes. SQL window query, no
 * external state. Returns true when the user is under their budget.
 */
async function isUnderRateLimit(userId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return true;
  try {
    const r = await safeQuery<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM instinct_org_facts
        WHERE source_user_id = $1
          AND created_at > now() - interval '1 hour'`,
      [userId],
    );
    const n = parseInt(r.rows[0]?.count ?? "0", 10);
    return n < FACT_RATE_LIMIT_PER_HOUR;
  } catch {
    /* On DB error, fail closed — refuse the write rather than allow
       unbounded captures. */
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Map a corrective phrasing to the attribute it implicitly references.
 * The attribute keywords are what the assistant *previously said* about
 * the entity — e.g. user replies "no it is Porsche" after the assistant
 * said "associated with the client TWA"; the prior answer mentioned
 * "client", so the attribute is "client".
 */
const ATTRIBUTE_KEYWORDS: Record<string, RegExp> = {
  client: /\b(client|customer|account|brand)\b/i,
  owner: /\b(owner|assignee|lead|responsible|owner_name)\b/i,
  status: /\b(status|state)\b/i,
  due_date: /\b(due|deadline|due\s*date)\b/i,
  participant: /\b(participants?|attendees?|invitees?)\b/i,
};

/**
 * Detect a correction in the latest user message. Returns the inferred
 * attribute (from the previous assistant message's keywords) and the
 * corrected value.
 *
 * Patterns supported:
 *   "no, it is Porsche"
 *   "no it is Porsche"
 *   "actually it's Porsche"
 *   "correction: Porsche"
 *   "the client is actually Porsche"
 */
/* ReDoS guard: cap the input the regex engine sees. The patterns below
   contain alternations + bounded quantifiers ({1,120}) that, while
   bounded, are still expensive on adversarial input. A correction is a
   short phrase by definition; anything past 4 KiB is not a correction
   the assistant should learn from. */
const MAX_DETECT_INPUT_LEN = 4096;

export function detectCorrection(
  userText: string,
  priorAssistantText: string | undefined,
): CorrectionExtraction | null {
  if (!userText) return null;
  if (userText.length > MAX_DETECT_INPUT_LEN) return null;

  /* Pattern 1: "no, it is/its X" / "actually it is X" / "correction: X" */
  const m1 = /\b(?:no[,\s]+|actually[,\s]+)(?:it'?s|it\s+is|that'?s|that\s+is)\s+([^.!?\n]{1,120})/i.exec(
    userText,
  );
  const m1b = /\bcorrection[:\s]+([^.!?\n]{1,120})/i.exec(userText);
  /* Pattern 2: "the X is actually Y" / "X should be Y" */
  const m2 = /\bthe\s+([a-z][\w\s-]{1,40}?)\s+(?:is\s+actually|should\s+be|is)\s+([^.!?\n]{1,120})/i.exec(
    userText,
  );
  /* Pattern 3: bare "no, X" — only matches when message is short enough
     that we can be confident it's a one-word/phrase correction. */
  const m3 = /^no[,\s]+([A-Z][\w\s-]{1,80})\.?$/i.exec(userText.trim());

  let value: string | null = null;
  let explicitAttribute: string | null = null;

  if (m1) {
    value = m1[1].trim();
  } else if (m1b) {
    value = m1b[1].trim();
  } else if (m2) {
    explicitAttribute = m2[1].trim().toLowerCase();
    value = m2[2].trim();
  } else if (m3) {
    value = m3[1].trim();
  } else {
    return null;
  }

  /* Strip trailing common-words ("instead", "not TWA"). */
  value = value.replace(/\s+(instead|not\s+\S+)$/i, "").trim();
  if (!value) return null;

  if (explicitAttribute) {
    /* Map an explicit attribute phrase ("the client") to a canonical key. */
    for (const [key, re] of Object.entries(ATTRIBUTE_KEYWORDS)) {
      if (re.test(explicitAttribute)) return { attribute: key, value };
    }
    return { attribute: explicitAttribute, value };
  }

  /* Otherwise, infer the attribute from what the prior assistant
     answer most prominently mentioned. */
  if (priorAssistantText) {
    for (const [key, re] of Object.entries(ATTRIBUTE_KEYWORDS)) {
      if (re.test(priorAssistantText)) return { attribute: key, value };
    }
  }

  return { attribute: "fact", value };
}

/* ------------------------------------------------------------------ */
/* Subject extraction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Pull the most prominent quoted or capitalized entity from the prior
 * assistant answer. We prefer quoted strings ("foo bar"), then long
 * capitalized phrases, then the first non-trivial line. Heuristic, not
 * NLP — good enough for the agency-scale corpus.
 */
export function extractSubject(text: string | undefined): string | null {
  if (!text) return null;
  /* ReDoS guard — cap the input to a reasonable length before running
     character-class alternations that would otherwise be exponential
     on pathological input. */
  if (text.length > MAX_DETECT_INPUT_LEN) return null;
  const t = text.replace(/\n+/g, " ");

  /* 1. Double-quoted phrase. */
  const quoted = /"([^"\n]{3,120})"/.exec(t);
  if (quoted) return quoted[1].trim();

  /* 2. Title-cased multi-word phrase ≥ 2 words. Common pattern in
     meeting titles and project names. Reject if it starts with a
     month name (avoids capturing "April 30, 2026"). */
  const phrases = t.match(/[A-Z][\w&]*(?:\s+[A-Z&][\w&]*){1,8}/g) || [];
  const monthNames =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)/i;
  for (const p of phrases) {
    if (monthNames.test(p)) continue;
    if (p.length >= 6) return p.trim();
  }

  /* 3. First sentence-ish chunk. */
  const sentence = t.split(/[.!?\n]/).find((s) => s.trim().length >= 6);
  return sentence ? sentence.trim().slice(0, 120) : null;
}

function normalizeSubject(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export async function captureFactFromCorrection(args: {
  userMessage: string;
  priorAssistantContent: string | undefined;
  priorAssistantMessageId: string | null;
  userId: string;
  userRole: string;
}): Promise<OrgFact | null> {
  if (!process.env.DATABASE_URL) return null;

  /* Role allowlist — only members in the allowed set may write to the
     org-wide store. A future invite-only role would be rejected here
     until added to the allowlist deliberately. */
  if (!ALLOWED_FACT_ROLES.has(args.userRole)) return null;

  /* Per-user-per-hour rate limit. Above the budget, drop silently. */
  if (!(await isUnderRateLimit(args.userId))) return null;

  const correction = detectCorrection(
    args.userMessage,
    args.priorAssistantContent,
  );
  if (!correction) return null;

  /* Sanitize at the boundary: strip control characters and cap length,
     then reject obvious prompt-injection cues. */
  const cleanValue = sanitizeFactValue(correction.value);
  if (!isAllowedFactValue(cleanValue)) return null;
  const cleanAttribute = sanitizeFactAttribute(correction.attribute);

  const subjectRaw = extractSubject(args.priorAssistantContent);
  if (!subjectRaw) return null;
  const cleanSubject = sanitizeFactValue(subjectRaw);
  if (!cleanSubject) return null;

  try {
    const subjectNormalized = normalizeSubject(cleanSubject);

    /* Supersede any existing active fact for the same (subject, attribute)
       — newer corrections always win. The old row stays for history. */
    await safeQuery(
      `UPDATE instinct_org_facts
          SET superseded_by = NULL
        WHERE subject_normalized = $1
          AND attribute = $2
          AND superseded_by IS NULL
          AND value = $3`,
      [subjectNormalized, cleanAttribute, cleanValue],
    );

    const r = await safeQuery<{
      id: string;
      subject: string;
      attribute: string;
      value: string;
    }>(
      `INSERT INTO instinct_org_facts
         (subject, subject_normalized, attribute, value,
          source_message_id, source_user_id, source_user_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, subject, attribute, value`,
      [
        cleanSubject,
        subjectNormalized,
        cleanAttribute,
        cleanValue,
        args.priorAssistantMessageId,
        args.userId,
        args.userRole,
      ],
    );

    /* Mark prior facts for this (subject, attribute) as superseded. */
    if (r.rows[0]) {
      await safeQuery(
        `UPDATE instinct_org_facts
            SET superseded_by = $1
          WHERE subject_normalized = $2
            AND attribute = $3
            AND id <> $1
            AND superseded_by IS NULL`,
        [r.rows[0].id, subjectNormalized, cleanAttribute],
      );
    }

    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Lookup for prompt injection                                         */
/* ------------------------------------------------------------------ */

/**
 * Find org facts whose subject appears in the question text. Returns
 * the active (non-superseded) version of each match. Caps at 5 — more
 * than that and the prompt gets noisy.
 */
export async function findRelevantFacts(
  question: string,
  limit = 5,
): Promise<OrgFact[]> {
  if (!process.env.DATABASE_URL) return [];
  if (!question || question.length < 3) return [];
  const lowered = question.toLowerCase();
  try {
    const r = await safeQuery<{
      id: string;
      subject: string;
      attribute: string;
      value: string;
    }>(
      `SELECT id, subject, attribute, value
         FROM instinct_org_facts
        WHERE superseded_by IS NULL
          AND position(subject_normalized in $1) > 0
        ORDER BY helpful_count - contradicted_count DESC,
                 created_at DESC
        LIMIT $2`,
      [lowered, limit],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Build a small grounding block to inject into the system prompt.
 *  Every field is sanitized at render time as defense-in-depth — even
 *  if a poisoned value bypassed write-side validation, control chars
 *  and newlines cannot escape the grounding fence here. */
export function renderFactsBlock(facts: OrgFact[]): string {
  if (facts.length === 0) return "";
  const lines = facts.map((f) => {
    const subject = sanitizeFactValue(f.subject);
    const attribute = sanitizeFactAttribute(f.attribute);
    const value = sanitizeFactValue(f.value);
    return `- ${subject} → ${attribute}: ${value}`;
  });
  return [
    "Verified facts the team has provided about subjects in this question:",
    ...lines,
    "Treat the verified facts above as ground truth.",
    "",
  ].join("\n");
}

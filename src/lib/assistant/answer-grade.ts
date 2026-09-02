/**
 * Did the answer actually answer the question.
 *
 * The hygiene audit catches what an answer must never contain. This catches the
 * other failure: a clean, well-formed answer that does not address what was
 * asked, or refuses, or wanders. Those pass every deterministic check and are
 * still the wrong answer, so the only judge is one that reads both the question
 * and the reply and says whether one responds to the other.
 *
 * WHY A MODEL GRADES IT, and why that is not circular. The model under test
 * writes the answer; a SEPARATE cheap-tier call grades it against a fixed
 * rubric. A grader is a far easier job than an answerer: judging "does this
 * respond to that" is something a small model does reliably, where writing the
 * answer needed tools, retrieval and context. This is the standard eval shape,
 * a strong-enough judge over a fixed rubric, and it runs on the cheap tier so
 * grading a corpus costs cents.
 *
 * THE PROMPT AND THE PARSER ARE PURE, here, so the rubric is visible and the
 * parsing is tested without spending a model call. The single completion lives
 * in the harness, which already owns the router.
 */

/** The grade a single answer earns. */
export interface AnswerGrade {
  /** 0 no, 1 partial, 2 yes. The one number the harness averages. */
  score: 0 | 1 | 2;
  /** One line, the grader's reason, for a person scanning the failures. */
  reason: string;
}

/**
 * The grading prompt. A tight rubric, because a vague one gets a vague grade.
 *
 * It is told to grade RESPONSIVENESS, not correctness: whether the answer is
 * about the question. Correctness needs ground truth the harness does not have
 * for an arbitrary prompt, and conflating the two produces a number nobody can
 * act on. "Did it address what was asked" is answerable from the two texts
 * alone, and it is the failure that actually shows up: a refusal, an off-topic
 * reply, a generic non-answer.
 */
export function buildGradePrompt(question: string, answer: string): string {
  return [
    "Grade whether a reply ADDRESSES a question. This is not about whether it is",
    "correct, only whether it responds to what was asked.",
    "",
    "Score exactly one of:",
    "  2 - answers the question directly",
    "  1 - partly, or answers a near-but-different question",
    "  0 - does not address it: a refusal, an error, or off-topic",
    "",
    `Question: ${question}`,
    `Reply: ${answer}`,
    "",
    'Respond with ONLY: {"score": 0|1|2, "reason": "<one short line>"}',
  ].join("\n");
}

/**
 * Read the grader's reply into a grade.
 *
 * Tolerant on the way in, strict on the way out. The model is asked for JSON
 * and usually gives it, but a stray sentence around it, or a bare number, must
 * not crash a corpus run. An unreadable grade returns score 0 with a reason
 * that says the grade could not be read, which is the honest outcome: a grade
 * nobody can parse is not a passing grade.
 */
export function parseGrade(raw: string): AnswerGrade {
  const text = (raw ?? "").trim();

  const json = text.match(/\{[\s\S]*?\}/);
  if (json) {
    try {
      const obj = JSON.parse(json[0]) as { score?: unknown; reason?: unknown };
      const n = Number(obj.score);
      if (n === 0 || n === 1 || n === 2) {
        return { score: n, reason: typeof obj.reason === "string" ? obj.reason.slice(0, 120) : "" };
      }
    } catch {
      /* silent-ok: malformed JSON is expected from a small grader and is
         handled by the looser score reads below, then a scored-0 default. */
    }
  }

  /* A bare score somewhere in the text, e.g. "score: 2" or just "2". */
  const bare = text.match(/\bscore\b[^0-9]*([012])\b/i) ?? text.match(/^\s*([012])\b/);
  if (bare) {
    const n = Number(bare[1]) as 0 | 1 | 2;
    return { score: n, reason: "score read from an unstructured reply" };
  }

  return { score: 0, reason: "grade could not be read" };
}

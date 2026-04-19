/**
 * Claude Report Generator — AI-powered custom report creation.
 *
 * One of the few practical AI applications in Instinct. Used when the user
 * provides a freeform prompt for a custom report that can't be generated
 * from templates alone.
 *
 * The entire flow is tracked for the learning loop:
 *   - Prompt sent to Claude (tokens, latency)
 *   - Response received (content length, quality)
 *   - User rating (1-5 stars)
 *   - Cached for future similar prompts (zero-token on repeat)
 *
 * Requires ANTHROPIC_API_KEY env var. Falls back to template-only
 * generation if not set.
 */

import { trackEvent } from "@/lib/analytics";
import { cleanAiArtifacts } from "@/lib/report-templates";
import { safeQuery } from "@/lib/db";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

interface ClaudeReportRequest {
  prompt: string;
  clientName: string;
  productContext?: string;
  sections?: string[];     // building blocks to include
  userId: string;
  userRole: string;
}

interface ClaudeReportResult {
  content: string;         // markdown report
  tokensUsed: number;
  latencyMs: number;
  model: string;
  cached: boolean;         // true if served from knowledge base cache
}

/**
 * Check knowledge cache for a similar prompt before calling Claude.
 */
async function checkCache(prompt: string): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;

  try {
    const result = await safeQuery<{ answer: string; id: string }>(
      `SELECT id, answer FROM apex_knowledge
       WHERE question % $1
         AND source = 'ai'
         AND rating >= 3
         AND tags @> ARRAY['report']
       ORDER BY similarity(question, $1) DESC
       LIMIT 1`,
      [prompt],
    );

    if (result.rows.length > 0 && !result.fromCache) {
      // Increment view count
      const { query } = await import("@/lib/db");
      await query(
        "UPDATE apex_knowledge SET view_count = view_count + 1 WHERE id = $1",
        [result.rows[0].id],
      ).catch(() => {});
      return result.rows[0].answer;
    }
  } catch {
    // pg_trgm similarity search may not be available, skip cache
  }

  return null;
}

/**
 * Call Claude API to generate a custom report.
 */
async function callClaude(
  prompt: string,
  clientName: string,
  productContext: string,
): Promise<{ content: string; tokensUsed: number; latencyMs: number; model: string }> {
  if (!ANTHROPIC_API_KEY) {
    // No API key — return a helpful message instead of failing
    return {
      content: `## Custom Report for ${clientName}\n\n> This report requires the Claude AI integration. Set the ANTHROPIC_API_KEY environment variable to enable custom report generation.\n\n**Your prompt:** ${prompt}\n\n---\n\nIn the meantime, try using one of the pre-built report templates which generate content from your actual codebase and database (zero AI cost).\n`,
      tokensUsed: 0,
      latencyMs: 0,
      model: "none",
    };
  }

  const systemPrompt = `You are a professional report writer for Wolfpack Agency, a technology company that builds automotive dealer platforms.

Write in a direct, professional tone. Use plain language that a business person can understand.

CRITICAL RULES:
- NEVER use em dashes. Use commas or periods instead.
- NEVER use "leverage", "utilize", "delve", "tapestry", "synergy", "robust", "seamless", "cutting-edge", "best-in-class", "game-changing", "holistic", "paradigm".
- Use "use" not "utilize". Use "explore" not "delve into". Use "improve" not "leverage".
- Write in active voice.
- Keep sentences varied in length. Mix short and long.
- Be specific and factual. Reference actual features, not vague promises.
- Format as clean markdown with ## headers, bullet points, and bold for emphasis.

${productContext ? `\nProduct context:\n${productContext}` : ""}`;

  const start = Date.now();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate a professional report for ${clientName}.\n\n${prompt}`,
        },
      ],
    }),
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || "";
  const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

  return { content, tokensUsed, latencyMs, model: ANTHROPIC_MODEL };
}

/**
 * Generate a custom report using Claude AI.
 *
 * Flow: check cache -> call Claude if miss -> clean artifacts -> cache result -> track everything
 */
export async function generateCustomReport(req: ClaudeReportRequest): Promise<ClaudeReportResult> {
  const { prompt, clientName, productContext, userId, userRole } = req;

  // 1. Check cache first (zero tokens if found)
  const cached = await checkCache(prompt);
  if (cached) {
    trackEvent("system.ai_call_skipped", userId, userRole, {
      reason: "cache_hit",
      prompt_length: prompt.length,
      module: "custom_report",
    });
    return {
      content: cached,
      tokensUsed: 0,
      latencyMs: 0,
      model: "cached",
      cached: true,
    };
  }

  // 2. Call Claude
  trackEvent("system.ai_call_made", userId, userRole, {
    module: "custom_report",
    prompt_length: prompt.length,
    client: clientName,
  });

  const result = await callClaude(prompt, clientName, productContext || "");

  // 3. Clean AI artifacts from the response
  const cleanedContent = cleanAiArtifacts(result.content);

  // 4. Cache the result for future similar prompts
  if (process.env.DATABASE_URL && result.tokensUsed > 0) {
    try {
      const { query } = await import("@/lib/db");
      await query(
        `INSERT INTO apex_knowledge (question, answer, source, asked_by, tags, tokens_used)
         VALUES ($1, $2, 'ai', $3, ARRAY['report', 'custom', 'claude'], $4)`,
        [prompt, cleanedContent, userId, result.tokensUsed],
      ).catch(() => {});
    } catch {
      // Cache failure is non-fatal
    }
  }

  // 5. Track the AI usage for the learning loop
  trackEvent("client.doc_generated", userId, userRole, {
    source: "claude",
    tokens_used: result.tokensUsed,
    latency_ms: result.latencyMs,
    model: result.model,
    prompt_length: prompt.length,
    response_length: cleanedContent.length,
    client: clientName,
  });

  return {
    content: cleanedContent,
    tokensUsed: result.tokensUsed,
    latencyMs: result.latencyMs,
    model: result.model,
    cached: false,
  };
}

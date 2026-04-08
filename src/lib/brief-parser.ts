/**
 * Brief Parser — turn dragged HTML / PDF / docx text into a draft brief.
 *
 * Two-stage strategy (zero-tokens-first):
 *   1. Heuristic pass — strip HTML, find headings, stat patterns, image
 *      references. If the input is already structured enough we return a
 *      basic brief without calling AI at all.
 *   2. AI pass (only if heuristic confidence is low) — send the cleaned
 *      text to Claude with a strict JSON schema prompt and validate the
 *      output against validateBrief() before returning.
 *
 * Every parse attempt emits a tracked event with source ("heuristic" or
 * "ai"), token count, and confidence so the brain learns which input
 * shapes the heuristic handles vs. which need AI. NO data lost — failed
 * parses still emit `site.brief_parse_failed` with the error.
 */

import { trackEvent } from "@/lib/analytics";
import { validateBrief, BriefValidationError, type SiteBrief } from "@/lib/sites";

export interface ParseResult {
  brief: SiteBrief;
  source: "heuristic" | "ai";
  tokensUsed: number;
  confidence: "low" | "medium" | "high";
}

/* --------------------------- HTML stripping --------------------------- */

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------- Heuristic pass --------------------------- */

const STAT_RE = /(\d[\d,.]*[KkMmBb]?\+?)\s+([A-Z][A-Za-z &/-]{2,40})/g;

/**
 * Pull headings (h1/h2/h3) out of the original HTML if present, then fall
 * back to splitting cleaned text on capitalized lines.
 */
function extractHeadings(html: string): string[] {
  const out: string[] = [];
  const tagRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const text = stripHtml(m[1]);
    if (text && text.length < 120) out.push(text);
  }
  return out;
}

function extractStats(text: string): Array<{ label: string; value: number; suffix?: string }> {
  const out: Array<{ label: string; value: number; suffix?: string }> = [];
  let m: RegExpExecArray | null;
  STAT_RE.lastIndex = 0;
  while ((m = STAT_RE.exec(text)) !== null) {
    const raw = m[1];
    const label = m[2].trim();
    const numStr = raw.replace(/[KkMmBb+,]/g, "");
    const num = parseFloat(numStr);
    if (Number.isNaN(num)) continue;
    let value = num;
    let suffix = "";
    if (/[Kk]/.test(raw)) { value = num; suffix = "K"; }
    else if (/[Mm]/.test(raw)) { value = num; suffix = "M"; }
    else if (/[Bb]/.test(raw)) { value = num; suffix = "B"; }
    if (raw.endsWith("+")) suffix += "+";
    out.push({ label, value, suffix });
    if (out.length >= 12) break;
  }
  return out;
}

function extractImages(html: string): Array<{ src: string; alt: string }> {
  const out: Array<{ src: string; alt: string }> = [];
  const re = /<img\s+[^>]*src=["']([^"']+)["'][^>]*?(?:alt=["']([^"']*)["'])?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (src.startsWith("data:")) continue; // skip embedded base64 in v1
    out.push({ src, alt: m[2] ?? "" });
    if (out.length >= 9) break;
  }
  return out;
}

export function heuristicParse(
  rawInput: string,
  clientSlug: string,
): { brief: SiteBrief; confidence: "low" | "medium" | "high" } {
  const looksHtml = /<[a-z][\s\S]*?>/i.test(rawInput);
  const html = looksHtml ? rawInput : "";
  const text = stripHtml(rawInput);

  const headings = looksHtml ? extractHeadings(html) : [];
  const stats = extractStats(text);
  const images = looksHtml ? extractImages(html) : [];

  const productName = headings[0] ?? text.split(/[.!?]/)[0].slice(0, 60).trim() ?? clientSlug;
  const tagline = headings[1] ?? text.split(/[.!?]/)[1]?.slice(0, 120).trim() ?? "";

  const sections: SiteBrief["pages"][0]["sections"] = [
    { type: "hero", heading: productName, body: tagline, cta: { label: "Get in touch", href: "/contact" } },
  ];

  // First substantive paragraph as text section
  const paragraphs = text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((p) => p.length > 40);
  if (paragraphs[0]) {
    sections.push({ type: "text", heading: "About", body: paragraphs[0].slice(0, 600) });
  }

  if (stats.length >= 3) {
    sections.push({ type: "stats", heading: "By the numbers", items: stats.slice(0, 8) });
  }

  if (images.length >= 2) {
    sections.push({
      type: "gallery",
      heading: "Gallery",
      images: images.slice(0, 6),
    });
  }

  // Confidence: high = headings + stats + images all found; low = mostly empty
  const score = (headings.length > 1 ? 1 : 0) + (stats.length >= 3 ? 1 : 0) + (images.length >= 2 ? 1 : 0);
  const confidence: "low" | "medium" | "high" = score >= 3 ? "high" : score >= 1 ? "medium" : "low";

  const brief: SiteBrief = {
    client: clientSlug,
    product: { name: productName, tagline },
    pages: [{ route: "/", title: productName, sections }],
    contactForm: { fields: ["name", "email", "message"] },
  };

  return { brief, confidence };
}

/* ------------------------------- AI pass ----------------------------- */

const SYSTEM_PROMPT = `You are a content extractor for the Wolfpack site template. Given a design brief or marketing document, output a JSON brief that conforms exactly to this TypeScript shape:

interface SiteBrief {
  client: string;            // lowercase slug, a-z 0-9 -
  product: { name: string; tagline?: string; supportEmail?: string };
  pages: Array<{
    route: string;           // starts with /
    title?: string;
    sections: Array<
      | { type: "hero"; heading: string; body?: string; cta?: { label: string; href: string }; backgroundImage?: string }
      | { type: "text"; heading?: string; body: string }
      | { type: "callout"; body: string }
      | { type: "banner"; heading: string; body?: string }
      | { type: "stats"; heading?: string; items: Array<{ label: string; value: number; suffix?: string; prefix?: string }> }
      | { type: "cards"; heading?: string; items: Array<{ title: string; body?: string; badge?: string; accent?: boolean }> }
      | { type: "gallery"; heading?: string; images: Array<{ src: string; alt?: string }> }
      | { type: "quote"; body: string; attribution?: string }
    >;
  }>;
  contactForm?: { fields: string[] };
}

RULES:
- stats.items[].value MUST be a number (no strings, no units; put units in suffix)
- gallery.images MUST be an array even if empty
- Use only the section types listed above
- Output ONLY valid JSON, no markdown, no commentary, no \`\`\` fences`;

export interface AICaller {
  (systemPrompt: string, userText: string): Promise<{ content: string; tokensUsed: number } | null>;
}

export const defaultAICaller: AICaller = async (systemPrompt, userText) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      content: data.content?.[0]?.text ?? "",
      tokensUsed: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };
  } catch {
    return null;
  }
};

export async function aiParse(
  rawInput: string,
  clientSlug: string,
  ai: AICaller = defaultAICaller,
): Promise<{ brief: SiteBrief; tokensUsed: number } | null> {
  const cleaned = stripHtml(rawInput).slice(0, 24000);
  const userText = `client_slug: "${clientSlug}"\n\nDocument:\n${cleaned}`;
  const result = await ai(SYSTEM_PROMPT, userText);
  if (!result) return null;
  // Strip any accidental code fences
  const json = result.content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(json);
    parsed.client = clientSlug; // force the slug we were given
    validateBrief(parsed);
    return { brief: parsed, tokensUsed: result.tokensUsed };
  } catch {
    return null;
  }
}

/* ----------------------- Public entrypoint --------------------------- */

export async function parseBrief(
  rawInput: string,
  clientSlug: string,
  userId: string,
  userRole: string,
  ai: AICaller = defaultAICaller,
): Promise<ParseResult> {
  // Stage 1: heuristic
  const h = heuristicParse(rawInput, clientSlug);
  if (h.confidence === "high") {
    try {
      validateBrief(h.brief);
      trackEvent("site.brief_auto_parsed", userId, userRole, {
        source: "heuristic",
        confidence: "high",
        tokens_used: 0,
        section_count: h.brief.pages[0].sections.length,
      });
      return { brief: h.brief, source: "heuristic", tokensUsed: 0, confidence: "high" };
    } catch {
      // fall through to AI
    }
  }

  // Stage 2: AI
  const ai_result = await aiParse(rawInput, clientSlug, ai);
  if (ai_result) {
    trackEvent("site.brief_auto_parsed", userId, userRole, {
      source: "ai",
      confidence: "high",
      tokens_used: ai_result.tokensUsed,
      section_count: ai_result.brief.pages[0]?.sections.length ?? 0,
    });
    return { brief: ai_result.brief, source: "ai", tokensUsed: ai_result.tokensUsed, confidence: "high" };
  }

  // Stage 3: fall back to whatever the heuristic produced (medium/low),
  // even if AI failed — better than nothing, user can edit.
  try {
    validateBrief(h.brief);
    trackEvent("site.brief_auto_parsed", userId, userRole, {
      source: "heuristic",
      confidence: h.confidence,
      tokens_used: 0,
      ai_failed: true,
    });
    return { brief: h.brief, source: "heuristic", tokensUsed: 0, confidence: h.confidence };
  } catch (err) {
    trackEvent("site.brief_parse_failed", userId, userRole, {
      error: err instanceof BriefValidationError ? err.errors.join("; ") : (err as Error).message,
    });
    throw err;
  }
}

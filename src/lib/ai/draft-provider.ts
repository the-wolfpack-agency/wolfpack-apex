/**
 * AI draft provider — provider-neutral interface for "draft me a
 * reply" calls. Currently routes to Anthropic Claude; built behind
 * an interface so the planned Azure OpenAI Service swap is mechanical
 * (replace one function body, no consumer code touched).
 *
 * Surfaces that consume this:
 *   - chat composer in /messages (smart reply for Teams DMs/groups)
 *   - email composer ComposeDrawer (smart reply for Outlook threads)
 *   - channel composer in /messages (smart reply for Teams channels)
 *
 * Every call emits analytics — see assistant.draft_* events in
 * src/lib/analytics.ts. The user's acceptance/rejection pattern is
 * itself the highest-quality training signal we collect, so the
 * downstream learning store should NEVER drop these events.
 */

export type DraftSurface = "chat" | "channel" | "email";

export interface DraftRequestContext {
  /** Which surface is asking — affects tone (chat short, email formal). */
  surface: DraftSurface;
  /** Display name of the person being replied to, if known. */
  recipientName?: string;
  /** Last few messages of the thread, oldest → newest. */
  threadContext?: { from: string; text: string }[];
  /** Whatever the user has already typed (we extend it, not replace). */
  draftSoFar?: string;
  /** Optional one-word tone hint: "concise", "warm", "direct", etc. */
  tone?: string;
  /** Caller's display name — so the draft signs off correctly. */
  selfName?: string;
}

export interface DraftResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface DraftProvider {
  draftReply(ctx: DraftRequestContext): Promise<DraftResult>;
}

// ---------------------------------------------------------------------------
// Prompt construction — kept here (not in the provider) so any provider
// swap reuses the same prompt logic. Azure OpenAI / Claude / etc all
// accept system + user message sequences.
// ---------------------------------------------------------------------------

const MAX_THREAD_TURNS = 12;
const MAX_DRAFT_LEN = 800;

function systemPromptFor(surface: DraftSurface, tone?: string): string {
  const base =
    "You are an assistant that drafts short, natural replies on behalf of " +
    "the user. Always respond ONLY with the draft text — no preamble, no " +
    'commentary, no "Here is a draft:" wrapper.';
  const surfaceHint =
    surface === "chat"
      ? "Surface: 1:1 / group chat. Keep it conversational, 1–3 sentences, " +
        "no salutation, no signature."
      : surface === "channel"
        ? "Surface: Teams channel post. Keep it tight, on-topic, 2–4 sentences. " +
          "No salutation. End without a signature."
        : "Surface: email reply. Match the formality of the prior thread. " +
          "Include a short greeting if the thread did, and a brief sign-off " +
          "with the user's first name.";
  const toneHint = tone ? `Tone: ${tone}.` : "";
  return [base, surfaceHint, toneHint].filter(Boolean).join(" ");
}

function userPromptFor(ctx: DraftRequestContext): string {
  const lines: string[] = [];
  if (ctx.recipientName) lines.push(`Replying to: ${ctx.recipientName}.`);
  if (ctx.selfName) lines.push(`You are: ${ctx.selfName}.`);
  if (ctx.threadContext && ctx.threadContext.length > 0) {
    const recent = ctx.threadContext.slice(-MAX_THREAD_TURNS);
    lines.push("Recent thread (oldest → newest):");
    for (const t of recent) {
      lines.push(`  ${t.from}: ${t.text.slice(0, 800)}`);
    }
  }
  if (ctx.draftSoFar && ctx.draftSoFar.trim()) {
    lines.push(
      `Continue / refine this draft (do not discard it): "${ctx.draftSoFar.slice(0, MAX_DRAFT_LEN).trim()}"`,
    );
  } else {
    lines.push("Write the reply.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Anthropic Claude implementation — current default. Swap to
// AzureOpenAIDraftProvider by changing only `getDraftProvider()`.
// ---------------------------------------------------------------------------

class AnthropicDraftProvider implements DraftProvider {
  async draftReply(ctx: DraftRequestContext): Promise<DraftResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_DRAFT_MODEL || "claude-sonnet-4-20250514";
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }
    const system = systemPromptFor(ctx.surface, ctx.tone);
    const userMsg = userPromptFor(ctx);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const text =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim() ?? "";
    return {
      text,
      model: data.model ?? model,
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Future: AzureOpenAIDraftProvider would live here. Same interface —
// consumers won't change. Wire it in by changing getDraftProvider()
// to return new AzureOpenAIDraftProvider() based on an env flag like
// AI_PROVIDER=azure.
// ---------------------------------------------------------------------------

let cached: DraftProvider | null = null;
export function getDraftProvider(): DraftProvider {
  if (cached) return cached;
  // When the Azure swap lands: branch here on process.env.AI_PROVIDER.
  cached = new AnthropicDraftProvider();
  return cached;
}

// Test seam — let route tests inject a mock provider.
export function __setDraftProviderForTests(p: DraftProvider | null): void {
  cached = p;
}

/**
 * email_thread_widget — renders an inline list of recent emails.
 *
 * Trigger phrases:
 *   "inbox"  /  "show me my inbox"  /  "recent emails"  /  "email widget"
 *   "show my email"  /  "show inbox"  /  "my recent emails"
 *
 * Pulls the latest N messages from Microsoft Graph (existing
 * fetchRecentEmails reader). The renderer lets the user click into
 * Outlook for each row. Graceful fallback when Graph fails — the
 * widget still renders with a clear "couldn't reach Outlook" answer.
 */

import { z } from "zod";
import { fetchRecentEmails } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  EmailThreadWidgetSpec,
  EmailThreadMessage,
} from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  count: z.number().int().min(1).max(50).default(10),
});
type Params = z.infer<typeof ParamSchema>;

interface EmailWidgetData {
  kind: "email_thread";
  messageCount: number;
}

const INTENT_RE =
  /^(?:inbox|show\s+(?:me\s+)?(?:my\s+)?inbox|recent\s+emails?|show\s+(?:me\s+)?(?:my\s+)?(?:recent\s+)?emails?|email\s+widget|show\s+(?:my\s+)?email)[\s.?!]*$/i;

function matchEmailWidgetIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return { count: 10 };
}

function truncatePreview(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1).trimEnd() + "…";
}

export const emailThreadWidgetTool: ToolDef<Params, EmailWidgetData> = {
  name: "email_thread_widget",
  description:
    "Render a list of the user's recent emails in the chat with deep links to Outlook. Use when the user asks for 'inbox' or 'recent emails' as a standalone prompt.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchEmailWidgetIntent,
  async handler(params, ctx): Promise<ToolResult<EmailWidgetData>> {
    let messages: EmailThreadMessage[] = [];
    let answer: string;
    try {
      const raw = await fetchRecentEmails(ctx.userId, params.count);
      messages = raw.map((m) => ({
        id: m.id,
        subject: m.subject || "(no subject)",
        from: m.from || m.fromEmail || "Unknown sender",
        fromEmail: m.fromEmail || "",
        receivedAt: m.receivedDateTime,
        preview: truncatePreview(m.bodyPreview || ""),
        isRead: m.isRead,
        importance: m.importance,
        webLink: m.webLink,
      }));
      const unread = messages.filter((m) => !m.isRead).length;
      answer =
        messages.length === 0
          ? "Your inbox looks empty right now."
          : `Here are your ${messages.length} most recent emails${unread > 0 ? ` (${unread} unread)` : ""}. Click any row to open it in Outlook.`;
    } catch (err) {
      console.warn("[email-thread-widget] fetchRecentEmails failed:", (err as Error).message);
      answer =
        "I couldn't reach Outlook just now. Open Email from the sidebar to retry, or try again in a moment.";
    }

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "email_thread",
      message_count: messages.length,
    });

    const spec: EmailThreadWidgetSpec = {
      kind: "email_thread",
      title: "Recent inbox",
      subtitle: messages.length > 0 ? `${messages.length} most recent` : undefined,
      messages,
    };

    return {
      ok: true,
      data: { kind: "email_thread", messageCount: messages.length },
      answer,
      widget: spec,
    };
  },
};

registerTool(emailThreadWidgetTool);

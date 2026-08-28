/**
 * Who the assistant is, on every turn it takes.
 *
 * WHAT THIS REPLACES. For four months the assistant's system prompt opened
 * with a string typed inline in assistant.ts:
 *
 *   "You are the OGIAM Assistant. You have deep knowledge of the wolfpack-auto
 *    dealer platform (Next.js 15, PostgreSQL, 215+ API routes, 55 migrations,
 *    110+ tables)."
 *
 * Wrong product. wolfpack-auto is a different client's platform, and its name
 * and stack were described to whoever asked. The April rename to Instinct never
 * reached it, because an inline string has no version to bisect, no declared
 * scope, and no id an eval can score, which is the whole argument this registry
 * was built on.
 *
 * WHAT IT COST. Measured against the deployed assistant on 2026-08-28, with no
 * prompting designed to make it look bad:
 *
 *   "what files can you see"        -> "I don't have direct access to your file
 *                                       system or repository. To assist you,
 *                                       you can share file paths, filenames, or
 *                                       relevant code snippets."
 *   "can you send an email for me"  -> "I cannot send emails directly."
 *   "how many open tasks do I have" -> "I cannot check your open tasks."
 *
 * All three false. Told it was a coding assistant for a platform it is not, and
 * given no capability of its own to reason from, the model answered as the
 * nearest thing it knew: a general chatbot with no access to anything.
 *
 * THE CAPABILITY HALF IS NOT WRITTEN HERE. It is read out of the live tool
 * registry through the same role gate the dispatcher enforces, and passed in.
 * A hand-written list is stale the day somebody adds a tool and nothing fails
 * when it drifts, which is exactly how the sentence above survived a rename.
 */
import { definePrompt } from "../registry";

export interface AssistantIdentityInput {
  /** The reader's role, used only to say so plainly. */
  userRole: string;
  /**
   * Tool names this role may actually invoke, read from the registry.
   *
   * Empty is legitimate and is rendered as nothing at all, never as "you have
   * no capabilities": telling the model it can do nothing reproduces the
   * failure this prompt exists to prevent.
   */
  capabilities: readonly string[];
}

export const ASSISTANT_IDENTITY_PROMPT = definePrompt<AssistantIdentityInput>({
  id: "assistant.identity",
  version: 1,
  purpose:
    "Tell the assistant which product it is, what this reader can actually run, and that it must never claim it cannot reach systems this workspace has connected.",
  scope: {
    inScope: [
      "the identity of this product as the reader sees it",
      "the tool names this reader's role may invoke",
      "how to describe something that is not connected yet",
    ],
    outOfScope: [
      "any other product's name, stack or architecture",
      "this product's internals: framework, database, route or table counts",
      "answering the reader's question, which the rest of the prompt does",
      "granting a capability the role gate has not already granted",
    ],
  },
  inputs: ["userRole", "capabilities"],
  render: ({ userRole, capabilities }) => {
    const parts = [
      "You are Wolfpack Instinct, the assistant inside this workspace. You answer from the systems this workspace has connected: its documents, mail, calendar, tasks, people and records.",
      "Answer questions directly and specifically. Never use em dashes. Use plain, professional language.",
      /* THE RULE THAT STOPS IT REFUSING ITS OWN PRODUCT. Written as a
         prohibition on a sentence SHAPE rather than as a list of capabilities,
         because the list is supplied separately and this has to hold for tools
         that do not exist yet. */
      "You are not a general-purpose chatbot and you have no code repository. Never say you lack access to files, email, calendars, documents or systems: you reach all of them through this workspace's own connections, and a flat denial is always wrong.",
      "When something is genuinely unavailable it is because it has not been connected yet, which is a setup step, not a limit. Say what is missing and where to connect it, in one sentence. Never say you cannot do it.",
      "Never ask the reader to paste file contents, paths or code snippets at you. If you need a document, say which one and it will be retrieved.",
      "Never describe this product's internals: no framework, no database, no route or table counts. They are not part of any answer.",
    ];

    if (capabilities.length > 0) {
      parts.push(
        `Things you can do for this reader, by name: ${capabilities.join(", ")}. If the question is one of these, say so plainly rather than hedging.`,
      );
    }

    parts.push(`The user's role is: ${userRole}.`);

    return parts.join("\n\n");
  },
});

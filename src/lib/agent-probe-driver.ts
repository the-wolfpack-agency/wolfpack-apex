/**
 * Model driver for the agent-probe harness - turn any completion model (via the
 * platform router) into the "brain" that decides where to go next on a target.
 *
 * Model-agnostic on purpose: instead of relying on a provider's tool-calling
 * schema (which differs per model and excludes some entirely), it uses a tiny
 * text protocol - show the model the goal + the current page, ask for the next
 * path, parse one path or STOP. That fits the platform thesis (any model, same
 * harness) and lets us run frontier and open models side by side against the
 * SAME instrumented site to compare how each behaves.
 *
 * The completion call is injected (`CompleteFn`), so this is unit-testable with
 * no network and no keys; the live wiring adapts the router's complete() to it.
 */

import type { ProbeDriverCtx } from "@/lib/agent-probe";

/** The one dependency: given a prompt, return the model's text. The live wiring
 *  maps router.complete() to this. */
export type CompleteFn = (prompt: string) => Promise<string>;

/** Truncate a page body so a prompt stays bounded regardless of page size. */
function summarizeBody(body: string | null, max = 2000): string {
  if (!body) return "(no page yet - you are at the entry point)";
  return body.length > max ? `${body.slice(0, max)}\n...[truncated]` : body;
}

function buildPrompt(goal: string, base: string, ctx: ProbeDriverCtx): string {
  const visited = ctx.history.map((s) => s.path).join(", ") || "(none yet)";
  return [
    `Act as an autonomous web agent exploring the site ${base}.`,
    `Your goal: ${goal}`,
    `Paths you have already visited: ${visited}`,
    `Current page content:`,
    summarizeBody(ctx.lastBody),
    ``,
    `Decide the single next path to fetch to pursue your goal. Reply with ONLY a`,
    `path beginning with "/" (for example: /pricing), or the word STOP if you are`,
    `done. Do not explain.`,
  ].join("\n");
}

/**
 * Parse the model's reply into the next path, or null (STOP / nothing usable).
 * Tolerant of prose around the answer: takes the first path-looking token, and
 * treats an explicit STOP (when no path is present) as done.
 */
export function parseNextPath(modelText: string): string | null {
  const text = (modelText || "").trim();
  // A path token: starts with a single "/", not "//" (protocol-relative), and
  // runs to whitespace or a closing quote/paren.
  const m = text.match(/(?:^|[\s"'(`])(\/[^\s"'`)]*)/);
  if (m) {
    const path = m[1];
    if (path.startsWith("//")) return null; // protocol-relative -> reject (SSRF hygiene)
    return path;
  }
  return null; // no path (STOP, or an unusable answer)
}

export interface ModelDriverOptions {
  complete: CompleteFn;
  base: string;
  goal: string;
  /** If the completion throws, stop the run rather than loop. Default true. */
  stopOnError?: boolean;
}

/**
 * Build a driver for runAgentProbe backed by a model. Each step it prompts the
 * model with the current page + history and parses the next path.
 */
export function makeModelDriver(opts: ModelDriverOptions): (ctx: ProbeDriverCtx) => Promise<string | null> {
  const stopOnError = opts.stopOnError ?? true;
  return async (ctx: ProbeDriverCtx) => {
    let reply: string;
    try {
      reply = await opts.complete(buildPrompt(opts.goal, opts.base, ctx));
    } catch {
      if (stopOnError) return null;
      throw new Error("model completion failed");
    }
    return parseNextPath(reply);
  };
}

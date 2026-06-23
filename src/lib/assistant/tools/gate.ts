/**
 * Shared tool role gate.
 *
 * A tool declares the minimum role required to invoke it (its `capability`
 * field; "*" means any authenticated principal). This gate is the single source
 * of truth for "can this role invoke this tool", used both by the dispatcher
 * (to allow or refuse a live call) and by the agent self-onboarding scan (to
 * mark which tools an agent is permitted to use). Keeping one function means the
 * scan can never disagree with the runtime about what an agent may do.
 */

/** Role rank. Higher invokes everything a lower role can. Unlisted roles rank 0
 *  (least privilege). Mirrors the human role hierarchy. */
export const TOOL_ROLE_LEVEL: Record<string, number> = {
  ceo: 100,
  cto: 95,
  evp: 80,
  vp: 70,
  cco: 65,
  lead: 60,
  manager: 55,
  dev: 40,
  designer: 35,
  sales: 30,
  ops: 30,
  hr: 30,
  viewer: 10,
  member: 10,
};

/**
 * True when a principal with `role` may invoke a tool whose required level is
 * `toolCapability`. "*" is open to any authenticated principal.
 */
export function canInvokeTool(role: string, toolCapability: string): boolean {
  if (toolCapability === "*") return true;
  const need = TOOL_ROLE_LEVEL[toolCapability.toLowerCase()] ?? 0;
  const have = TOOL_ROLE_LEVEL[(role ?? "").toLowerCase()] ?? 0;
  return have >= need;
}

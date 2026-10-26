/**
 * Agent INTENT MISMATCH: hold a tool call that does not fit the declared task.
 *
 * The web side of Forcefield acts on intent before an exploit; this is the same
 * idea for an AI agent. A task is assigned with a declared scope ("read-only",
 * "no outbound send", "no secrets"). A hijacked or confused agent shows its
 * intent by reaching outside that scope: a read-only task that wants to write,
 * a summarization task that reads ~/.aws/credentials, a lookup that sends an
 * email. None of those needs a model to see: the tool's own metadata (mutation,
 * capability, name) and the literal targets in its parameters are enough.
 *
 * The verdict becomes an OGIAM signal (signals.intentMismatch), and the policy
 * rule R-INTENT-MISMATCH-ESCALATE turns it into "escalate": the step is HELD for
 * the agent's accountable owner (the existing approval + owner alert path), not
 * silently dropped and not run. In monitor mode it is recorded only.
 *
 * PURE + deterministic: same scope + action -> same verdict. No I/O, no model.
 * Only reason ids leave this module, never a parameter value.
 */
import { AI_TOOL_CONFIG_PROBE_PATHS } from "@/lib/forcefield-web/ruleset";

export type TaskAccess = "read_only" | "read_write";

/** What the task was declared to do. Every field is a permission; absent means
 *  the narrower default (no outbound send, no secrets). */
export interface DeclaredTaskScope {
  access: TaskAccess;
  /** The task may send data out (email, message, webhook, upload, publish). */
  outbound?: boolean;
  /** The task may touch credential / secret material (a key-rotation task). */
  secrets?: boolean;
}

export type IntentMismatchReason = "mutation_in_read_only_task" | "credential_target" | "outbound_send_out_of_scope";

export interface IntentMismatch {
  mismatch: boolean;
  reasons: IntentMismatchReason[];
}

export interface ScopedAction {
  tool: string;
  capability: string;
  isMutation: boolean;
  /** The validated tool parameters (raw; only scanned, never returned). */
  params: unknown;
}

/** Credential / secret file targets. Path-shaped, so ordinary prose ("my
 *  password reset email") does not match: each needs the file or directory
 *  name as a path segment. The AI-tool credential files reuse the web ruleset's
 *  list so the two stay one source. */
const CREDENTIAL_SEGMENTS: readonly RegExp[] = [
  /(?:^|[\s/\\"'=])\.env(?:\.[a-z0-9_-]+)?(?=$|[\s/\\"'?#])/i,
  /\.aws[/\\](?:credentials|config)\b/i,
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/i,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b/i,
  /\.git[/\\]config\b/i,
  /(?:^|[/\\])\.(?:npmrc|pypirc|netrc|pgpass|git-credentials)\b/i,
  /\.kube[/\\]config\b/i,
  /\.docker[/\\]config\.json\b/i,
  /\/etc\/(?:shadow|passwd|sudoers)\b/i,
  /\bwp-config\.php\b/i,
  /(?:^|[/\\])(?:credentials|secrets?)\.(?:json|ya?ml|toml|env)\b/i,
  /\.(?:pem|p12|pfx|key)(?=$|[\s"'?#])/i,
];

const AI_TOOL_SEGMENTS = AI_TOOL_CONFIG_PROBE_PATHS.map((p) => p.replace(/^\//, "").toLowerCase());

/** Tool / capability name tokens that mean "data leaves the system". Matched
 *  as whole tokens of the name split on . _ - : so "postgres" is not "post". */
const OUTBOUND_TOKENS = new Set(["send", "email", "mail", "sms", "webhook", "egress", "publish", "upload", "share", "post", "notify", "message", "tweet", "dm"]);
/** Read-side tokens that cancel an outbound match ("mail.read", "list_messages"). */
const READ_TOKENS = new Set(["read", "list", "get", "search", "fetch", "unread", "count", "view", "inbox"]);

function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 200) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) strings(x, out, depth + 1);
  return out;
}

/** True when any parameter value targets credential / secret material. */
export function targetsCredentials(params: unknown): boolean {
  for (const s of strings(params)) {
    if (CREDENTIAL_SEGMENTS.some((re) => re.test(s))) return true;
    const low = s.toLowerCase();
    if (AI_TOOL_SEGMENTS.some((seg) => low.includes(`/${seg}/`) || low.endsWith(`/${seg}`) || low.startsWith(`${seg}/`))) return true;
  }
  return false;
}

/** True when the tool's effect is an outbound send. */
export function isOutboundSend(tool: string, capability: string): boolean {
  const tokens = `${tool} ${capability}`.toLowerCase().split(/[\s._:\-/]+/).filter(Boolean);
  if (tokens.some((t) => READ_TOKENS.has(t))) return false;
  return tokens.some((t) => OUTBOUND_TOKENS.has(t));
}

/** Compare one action against the declared task scope. */
export function checkIntentMismatch(scope: DeclaredTaskScope, action: ScopedAction): IntentMismatch {
  const reasons: IntentMismatchReason[] = [];
  if (scope.access === "read_only" && action.isMutation) reasons.push("mutation_in_read_only_task");
  if (!scope.secrets && targetsCredentials(action.params)) reasons.push("credential_target");
  if (!scope.outbound && isOutboundSend(action.tool, action.capability)) reasons.push("outbound_send_out_of_scope");
  return { mismatch: reasons.length > 0, reasons };
}

/** Validate an untrusted declared scope (an API body field). Malformed -> null
 *  (no scope declared, so no mismatch check), never a wider scope. */
export function coerceDeclaredScope(v: unknown): DeclaredTaskScope | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.access !== "read_only" && o.access !== "read_write") return null;
  return { access: o.access, outbound: o.outbound === true, secrets: o.secrets === true };
}

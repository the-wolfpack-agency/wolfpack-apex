/**
 * Forcefield central ruleset - "update once, every site follows."
 *
 * A Forcefield-connected site runs a thin, stable edge shim. The VOLATILE part of
 * detection - which tools are scanners, which agents get the welcome lane, which
 * paths are traps - changes constantly as new scanners and crawlers appear. If
 * that lived in each site's code, adding a signature would mean editing and
 * redeploying N sites. Instead it lives HERE, served centrally, and each site
 * fetches + caches it. Update the ruleset once and every connected site reflects
 * it within the cache TTL, no per-site redeploy.
 *
 * Safety first: fetching is best-effort and FAIL-OPEN. Every site bundles
 * DEFAULT_RULESET, so if the central endpoint is slow, down, or returns garbage,
 * detection keeps working on the baked-in defaults - the central service can
 * never degrade a site. Pure + edge-safe apart from the single cached fetch.
 */
import { DEFAULT_TOOL_SIGNATURES, type ToolSignature } from "./fingerprint";
import type { KnownAgent } from "./classify";
import { coerceCarryover, type CarryoverEntry } from "./intent";
import { DEFAULT_STATE_CHANGE_RULES, coerceStateChangeRules, type StateChangeRules } from "./accountability";

export interface ForcefieldRuleset {
  /** Version marker so a site can log which ruleset it is running. */
  version: string;
  /** Allowlisted good agents (welcome lane). */
  knownAgents: KnownAgent[];
  /** Invisible honeypot paths - a request here is a scanner. */
  trapPaths: string[];
  /** Path prefixes that don't exist and are pure recon when requested
   *  (/wp-login.php, /.env, /.git, ...). */
  sensitivePaths: string[];
  /** Named tool signatures for the client fingerprint. */
  toolSignatures: ToolSignature[];
  /** Per-request fingerprints an administrator explicitly blocked from the
   *  board. Distributed here so a block made once turns the operator away on
   *  EVERY connected site (update-once). Only consulted when a site is in
   *  enforce mode; optional so an older ruleset without it still validates. */
  blockedFingerprints?: string[];
  /** Datacenter/cloud IPv4 prefixes ("base/bits") for hosting classification.
   *  Distributed here so the FULL provider range set (not just the bundled seed)
   *  reaches EVERY site at once and refreshes centrally - the united rollout: a
   *  coverage update ships to all client sites via one ruleset refresh, no
   *  re-vendor. Optional; a site with none falls back to its bundled seed. */
  datacenterPrefixes?: string[];
  /** Paths NATIVE to a platform (keyed by platform id, e.g. "wordpress"): on a
   *  site that declares that platform these are its own real paths, not recon, so
   *  they are never reported as a sensitive probe there. Optional. */
  platformPaths?: Record<string, string[]>;
  /** Published IPv4 ranges ("base/bits", same compact shape as
   *  datacenterPrefixes) per allowlisted agent id. A request whose UA claims an
   *  agent that has ranges here is VERIFIED when its IP falls inside them and an
   *  IMPERSONATION when it does not; an agent with no ranges is "unverifiable".
   *  Distributed centrally so every site verifies against current lists.
   *  Optional. */
  verifiedAgentRanges?: Record<string, string[]>;
  /** Named probe classes (e.g. "ai_tool_config"), each a list of sensitivePaths
   *  patterns. A probe that matched one of them carries props.probe_class, so
   *  the board can group what a scanner was after. Labels only, never a block.
   *  Optional; an older ruleset without it still validates. */
  probeClasses?: Record<string, string[]>;
  /** INTENT scoring (intent.ts): product id -> path patterns, merged over the
   *  bundled catalog, so a newly targeted product reaches every site centrally.
   *  Optional. */
  productPaths?: Record<string, string[]>;
  /** INTENT scoring: runtime id -> server-side file extensions. Optional. */
  runtimeExtensions?: Record<string, string[]>;
  /** INTENT scoring: declared stack token -> runtimes + products. Optional. */
  stackComponents?: Record<string, { runtimes: string[]; products: string[] }>;
  /** INTENT carryover: fingerprints proven hostile on a Forcefield site, each
   *  with its own expiry. DISTINCTIVE fingerprints only (the server applies
   *  autoblock-scope before serving). Consumed as tarpit, never as a block.
   *  Optional. */
  intentCarryover?: CarryoverEntry[];
  /** ACCOUNTABLE ACTIONS (accountability.ts): which requests are state-changing
   *  (methods + named action routes, shared and per site label) and which paths
   *  never are. Watch mode only: recorded, never blocked. Optional; absent or
   *  malformed falls back to the bundled defaults. */
  stateChange?: StateChangeRules;
}

/**
 * AI coding-assistant config and credential files (probe class
 * "ai_tool_config"). These hold MCP server definitions and model-provider API
 * keys, so a request for one on a web origin is key theft or recon: no site we
 * protect serves any of them (guarded by the route-collision test). A dotfile
 * pattern also covers its variants through observe.ts dotfileVariant
 * ("/.mcp" -> "/.mcp.json", "/.aider" -> "/.aider.conf.yml") and every path
 * under it ("/.cursor" -> "/.cursor/mcp.json"). Sources:
 *   SANS ISC diary 33150, scanners requesting /.claude/mcp.json,
 *   /.claude/settings.local.json, /.claude/.credentials.json,
 *   /.config/claude/.credentials.json, /.cursor/mcp.json, /.vscode/mcp.json,
 *   /.mcp/config.json: https://isc.sans.edu/diary/33150
 *   Ryvane AI-honeypot report (2026-09-11), most-requested agent secrets incl.
 *   .claude/.credentials.json and .aider.conf.yml:
 *   https://ryvane.ai/journal/ai-honeypot-traffic-trends-2026
 *   SANDWORM_MODE (Feb 2026) injects a rogue MCP server into Claude Code,
 *   Claude Desktop, Cursor, VS Code Continue and Windsurf configs:
 *   https://thehackernews.com/2026/02/malicious-npm-packages-harvest-crypto.html
 * File locations from each tool's docs: Claude Desktop
 * claude_desktop_config.json (https://modelcontextprotocol.io/quickstart/user),
 * Gemini CLI .gemini/.env holding GEMINI_API_KEY
 * (https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx),
 * Continue ~/.continue/config.yaml|json (https://docs.continue.dev/customize/config),
 * Windsurf ~/.codeium/windsurf/mcp_config.json. "/.vscode" (which covers
 * /.vscode/mcp.json) stays in the classic group above.
 */
export const AI_TOOL_CONFIG_PROBE_PATHS: readonly string[] = [
  "/.claude", "/.config/claude", "/.cursor", "/.mcp", "/claude_desktop_config.json",
  "/.gemini", "/.aider", "/.continue", "/.codeium",
];

/**
 * Admin / code-execution endpoints of self-hosted AI platforms that are
 * exploited in the wild (probe class "ai_tool_admin"). Only paths with a
 * published advisory or exploitation report are listed.
 *   Langflow CVE-2025-3248, unauthenticated exec() at /api/v1/validate/code
 *   (CISA KEV, 2025-05-05): https://thehackernews.com/2025/05/critical-langflow-flaw-added-to-cisa.html
 *   Langflow CVE-2026-33017, POST /api/v1/build_public_tmp/{flow_id}/flow,
 *   exploited within 20h: https://www.sysdig.com/blog/cve-2026-33017-how-attackers-compromised-langflow-ai-pipelines-in-20-hours
 *   LiteLLM CVE-2026-42271, MCP command injection at /mcp-rest/test/connection
 *   and /mcp-rest/test/tools/list (CISA KEV, 2026-06-08):
 *   https://labs.cloudsecurityalliance.org/research/csa-research-note-litellm-cve-2026-42271-ai-gateway-exploita/
 *   MLflow CVE-2023-1177, path traversal through /ajax-api/2.0/mlflow
 *   (https://advisories.gitlab.com/pkg/pypi/mlflow/CVE-2023-1177/, PoC
 *   https://github.com/protectai/Snaike-MLflow)
 *   ComfyUI botnet recon + Manager abuse, from the attacker's own script:
 *   https://censys.com/blog/comfyui-servers-cryptomining-proxy-botnet/
 * The Ollama API (/api/tags, /api/pull, ...) is listed with the LLMjacking
 * group above and classed here too.
 */
export const AI_TOOL_ADMIN_PROBE_PATHS: readonly string[] = [
  "/api/v1/validate/code", "/api/v1/build_public_tmp",
  "/mcp-rest",
  "/ajax-api/2.0/mlflow",
  "/object_info", "/system_stats", "/customnode/install", "/manager/reboot",
];

/** Ollama's native API, already a sensitive path (LLMjacking group). */
const OLLAMA_NATIVE_PATHS = ["/api/tags", "/api/ps", "/api/generate", "/api/chat", "/api/show", "/api/pull", "/api/embed"];

/** The bundled fallback baked into every site. Kept deliberately broad so a site
 *  running on defaults alone still detects the common cases. Every entry below is
 *  DATA, so a change reaches every connected site on the next ruleset refresh
 *  (no re-vendor). Each group cites where the indicator comes from. */
export const DEFAULT_RULESET: ForcefieldRuleset = {
  version: "bundled-3",
  knownAgents: [
    // Only vendor-DOCUMENTED tokens. Most-specific first is not needed: every
    // token is distinct (Claude-User does not contain ClaudeBot, etc.).
    { id: "Googlebot", uaMatch: "Googlebot" },
    // https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
    { id: "Google-CloudVertexBot", uaMatch: "Google-CloudVertexBot" },
    { id: "Bingbot", uaMatch: "bingbot" },
    // OpenAI: https://platform.openai.com/docs/bots
    { id: "GPTBot", uaMatch: "GPTBot" },
    { id: "OAI-SearchBot", uaMatch: "OAI-SearchBot" },
    { id: "ChatGPT-User", uaMatch: "ChatGPT-User" },
    // Anthropic: https://support.claude.com/en/articles/8896518
    { id: "ClaudeBot", uaMatch: "ClaudeBot" },
    { id: "Claude-User", uaMatch: "Claude-User" },
    { id: "Claude-SearchBot", uaMatch: "Claude-SearchBot" },
    // Perplexity: https://docs.perplexity.ai/guides/bots
    { id: "PerplexityBot", uaMatch: "PerplexityBot" },
    { id: "Perplexity-User", uaMatch: "Perplexity-User" },
    // Mistral: https://docs.mistral.ai/robots
    { id: "MistralAI-User", uaMatch: "MistralAI-User" },
    { id: "Applebot", uaMatch: "Applebot" },
    { id: "DuckDuckBot", uaMatch: "DuckDuckBot" },
    // https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
    { id: "DuckAssistBot", uaMatch: "DuckAssistBot" },
    { id: "Amazonbot", uaMatch: "Amazonbot" },
    // Meta: https://developers.facebook.com/docs/sharing/webmasters/web-crawlers
    { id: "Meta-ExternalAgent", uaMatch: "meta-externalagent" },
    { id: "Meta-ExternalFetcher", uaMatch: "meta-externalfetcher" },
  ],
  trapPaths: ["/_ff/records"],
  sensitivePaths: [
    // Classic recon. "/.env" also matches every "/.env.<suffix>" and "/.env~"
    // through the dotfile rule in observe.ts; the explicit variants below are the
    // ones seen in our own production telemetry (2026-10) and reach sites still
    // running an older vendored core that lacks that rule.
    "/wp-login.php", "/xmlrpc.php", "/wp-admin", "/.env", "/.git", "/.git/config",
    "/config.json", "/backup", "/.aws/credentials", "/.ssh", "/phpmyadmin",
    "/admin.php", "/vendor/", "/.vscode", "/.DS_Store", "/server-status",
    "/.env.production", "/.env.local", "/.env.backup", "/.env.bak", "/.env.old",
    "/.env.save", "/.env.swp", "/.env.dev", "/.env.development", "/.env.prod",
    "/.env.example", "/.env~", "/.git/HEAD",
    // wp-config.php is not a dotfile, so its editor/backup copies are listed
    // explicitly (they leak DB credentials when served as text).
    "/wp-config.php", "/wp-config.php.bak", "/wp-config.php.old", "/wp-config.php.save",
    "/wp-config.php.swp", "/wp-config.php~", "/wp-config.php.orig", "/wp-config.bak",
    "/wp-config.old", "/.wp-config.php.swp",
    // WordPress plugin recon on a NON-WordPress site (on a site that declares
    // platform "wordpress" these fall under platformPaths and are not recon).
    // The two named plugins are this month's mass-targeted ones, listed before
    // the generic /wp-content so the probe names them:
    //   UpdraftCentral stolen-key backdooring:
    //   https://patchstack.com/articles/updraftcentral-key-compromise-wordpress-backdoors/
    //   Rank Math PRO 3.0.123 supply-chain backdoor (CVE-2026-111862), no public
    //   inbound request indicators (Patchstack: "a rule is not possible"):
    //   https://patchstack.com/database/wordpress/plugin/seo-by-rank-math-pro/vulnerability/wordpress-rank-math-seo-pro-plugin-3-0-123-unauthenticated-embedded-malicious-code-vulnerability
    "/wp-content/plugins/updraftplus", "/wp-content/plugins/seo-by-rank-math-pro",
    "/wp-content", "/wp-includes", "/wp-json", "/wp-cron.php", "/wp-signup.php",
    // LLMjacking / exposed-AI-endpoint scanning. Paths seen in honeypots:
    //   Zenity, "Scanning for AI": /v1/chat/completions, /v1/messages, /v1/models,
    //   /api/tags, /api/chat, /api/generate, /api/version
    //   (https://labs.zenity.io/p/scanning-for-ai-live-campaigns-mapping-the-internet-s-exposed-llm-backends)
    //   SANS ISC diary 33150: POST /mcp, /sse, /v1/models, /api/tags and AI
    //   assistant config/credential files (https://isc.sans.edu/diary/33150)
    //   Symantec LLMjacking agent context:
    //   https://www.infosecurity-magazine.com/news/symantec-ai-agent-llmjacking/
    // plus the rest of the same servers' documented API surface (Ollama native
    // + OpenAI-compatible: /api/ps, /api/show, /api/pull, /api/embed,
    // /v1/completions, /v1/embeddings - https://github.com/ollama/ollama/blob/main/docs/api.md,
    // https://github.com/ollama/ollama/blob/main/docs/openai.md). "/api/version"
    // is deliberately ABSENT: it is a real Instinct route (guarded by the
    // route-collision test).
    "/v1/models", "/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/messages",
    "/api/v1/models", "/api/tags", "/api/ps", "/api/generate", "/api/chat", "/api/show",
    "/api/pull", "/api/embed", "/mcp", "/sse",
    // AI-tool config files and AI-platform admin endpoints (probe classes
    // ai_tool_config / ai_tool_admin, see probeClasses below).
    ...AI_TOOL_CONFIG_PROBE_PATHS,
    ...AI_TOOL_ADMIN_PROBE_PATHS,
  ],
  toolSignatures: [...DEFAULT_TOOL_SIGNATURES],
  blockedFingerprints: [],
  datacenterPrefixes: [],
  // Paths NATIVE to WordPress core: on a site that declares platform
  // "wordpress" a request here is the site's own surface, not recon (watch-first
  // WP plugin, see the WordPress adapter). Backup copies of wp-config.php are NOT
  // listed, so they stay a probe on WordPress too.
  platformPaths: {
    wordpress: [
      "/wp-login.php", "/wp-admin", "/xmlrpc.php", "/wp-json", "/wp-content", "/wp-includes",
      "/wp-cron.php", "/wp-signup.php", "/wp-activate.php", "/wp-comments-post.php",
      "/wp-trackback.php", "/wp-links-opml.php", "/wp-mail.php", "/wp-load.php",
    ],
  },
  probeClasses: {
    ai_tool_config: [...AI_TOOL_CONFIG_PROBE_PATHS],
    ai_tool_admin: [...AI_TOOL_ADMIN_PROBE_PATHS, ...OLLAMA_NATIVE_PATHS],
  },
  // Served live by the ruleset/observe routes from the vendors' published lists
  // (src/lib/forcefield/crawler-ranges.ts). Empty in the bundle = every claimed
  // agent is "unverifiable", never an impersonation.
  verifiedAgentRanges: {},
  stateChange: DEFAULT_STATE_CHANGE_RULES,
};

/** Validate + coerce an untrusted payload into a ruleset, or null if it is not
 *  shaped like one (so a malformed remote response fails open to the default
 *  rather than corrupting detection). */
export function coerceRuleset(data: unknown): ForcefieldRuleset | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const strArr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  // Strict: if ANY entry is malformed, treat the whole field as invalid so the
  // caller fails open to the bundled defaults rather than a half-parsed ruleset.
  const agents =
    Array.isArray(d.knownAgents) &&
    d.knownAgents.every((a) => !!a && typeof (a as KnownAgent).id === "string" && typeof (a as KnownAgent).uaMatch === "string")
      ? (d.knownAgents as KnownAgent[])
      : null;
  const traps = strArr(d.trapPaths);
  const sensitive = strArr(d.sensitivePaths);
  const sigs =
    Array.isArray(d.toolSignatures) &&
    d.toolSignatures.every((s) => Array.isArray(s) && s.length === 3 && s.every((x) => typeof x === "string"))
      ? (d.toolSignatures as ToolSignature[])
      : null;
  if (!agents || !traps || !sensitive || !sigs) return null;
  // Optional: absent or malformed -> empty (never blocks), so an older ruleset
  // still validates and a bad field can't accidentally enable enforcement.
  const blockedFingerprints = strArr(d.blockedFingerprints) ?? [];
  const datacenterPrefixes = strArr(d.datacenterPrefixes) ?? [];
  const strArrMap = (v: unknown): Record<string, string[]> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
      const a = strArr(arr);
      if (a) out[k] = a;
    }
    return out;
  };
  const platformPaths = strArrMap(d.platformPaths);
  const verifiedAgentRanges = strArrMap(d.verifiedAgentRanges);
  const probeClasses = strArrMap(d.probeClasses);
  const productPaths = strArrMap(d.productPaths);
  const runtimeExtensions = strArrMap(d.runtimeExtensions);
  const stackComponents: Record<string, { runtimes: string[]; products: string[] }> = {};
  if (d.stackComponents && typeof d.stackComponents === "object" && !Array.isArray(d.stackComponents)) {
    for (const [k, v] of Object.entries(d.stackComponents as Record<string, unknown>)) {
      const o = v as Record<string, unknown> | null;
      const r = o ? strArr(o.runtimes) : null;
      const pr = o ? strArr(o.products) : null;
      if (r && pr) stackComponents[k] = { runtimes: r, products: pr };
    }
  }
  const intentCarryover = coerceCarryover(d.intentCarryover);
  return {
    version: typeof d.version === "string" ? d.version : "remote",
    knownAgents: agents,
    trapPaths: traps,
    sensitivePaths: sensitive,
    toolSignatures: sigs,
    blockedFingerprints,
    datacenterPrefixes,
    platformPaths,
    verifiedAgentRanges,
    probeClasses,
    productPaths,
    runtimeExtensions,
    stackComponents,
    intentCarryover,
    stateChange: coerceStateChangeRules(d.stateChange) ?? DEFAULT_STATE_CHANGE_RULES,
  };
}

// Module-level cache: one fetch per TTL per edge instance, not per request.
let _cache: { at: number; ruleset: ForcefieldRuleset } | null = null;

/** Test-only: clear the cache between cases. */
export function _resetRulesetCache(): void {
  _cache = null;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch the central ruleset, cached, FAIL-OPEN. Never throws and never blocks a
 * request: on any failure (network, non-200, malformed body) it returns the last
 * good cached ruleset, or the bundled DEFAULT_RULESET if there is none. Pass a URL
 * of "" to run purely on the bundled defaults.
 */
export async function fetchRuleset(
  url: string,
  opts: { nowMs?: number; ttlMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ForcefieldRuleset> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (_cache && nowMs - _cache.at < ttlMs) return _cache.ruleset;
  if (!url) return _cache?.ruleset ?? DEFAULT_RULESET;
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(url, { headers: { accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { ruleset?: unknown } | unknown;
      // Accept either the { ruleset } envelope the endpoint serves or a bare ruleset.
      const raw = body && typeof body === "object" && "ruleset" in body ? (body as { ruleset: unknown }).ruleset : body;
      const parsed = coerceRuleset(raw);
      if (parsed) {
        _cache = { at: nowMs, ruleset: parsed };
        return parsed;
      }
    }
  } catch {
    /* fail-open below */
  }
  return _cache?.ruleset ?? DEFAULT_RULESET;
}

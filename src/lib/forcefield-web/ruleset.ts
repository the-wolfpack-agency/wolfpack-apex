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
}

/** The bundled fallback baked into every site. Kept deliberately broad so a site
 *  running on defaults alone still detects the common cases. Every entry below is
 *  DATA, so a change reaches every connected site on the next ruleset refresh
 *  (no re-vendor). Each group cites where the indicator comes from. */
export const DEFAULT_RULESET: ForcefieldRuleset = {
  version: "bundled-2",
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
    "/.claude", "/.config/claude", "/.cursor", "/.mcp",
    // ComfyUI botnet recon + Manager abuse, from the attacker's own script:
    // https://censys.com/blog/comfyui-servers-cryptomining-proxy-botnet/
    "/object_info", "/system_stats", "/customnode/install", "/manager/reboot",
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
  // Served live by the ruleset/observe routes from the vendors' published lists
  // (src/lib/forcefield/crawler-ranges.ts). Empty in the bundle = every claimed
  // agent is "unverifiable", never an impersonation.
  verifiedAgentRanges: {},
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

/**
 * MCP scanner detectors — precision-first, pure functions over config + tools.
 *
 * Each maps to a documented MCP attack class. As with every detector in this
 * codebase, the bar is signature-grade: known dangerous commands, real key
 * formats, specific injection phrasings, actual zero-width/bidi code points. A
 * noisy MCP scanner that flags every tool description would be worse than none,
 * because the whole pitch is "here are the REAL risks in your MCP setup".
 */
import { KEY_SIGNATURES } from "../detect";
import type { McpServerConfig, McpToolDef, McpFinding } from "./types";

// --- config-level detectors -------------------------------------------------

const PACKAGE_RUNNERS = new Set(["npx", "uvx", "pnpm", "pipx", "bunx"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "cmd", "powershell"]);
const CODE_EVAL_FLAGS = /^-(e|c|-eval)$/;

/** A package arg carries a version if it has an @version after the (optional)
 *  scope: name@1.2.3 or @scope/name@1.2.3. `@latest` is treated as unpinned. */
function isVersionPinned(pkg: string): boolean {
  if (pkg.endsWith("@latest")) return false;
  const at = pkg.lastIndexOf("@");
  // Scoped pkg starts with @, so a real version @ must be after index 0.
  return at > 0;
}

function finding(
  server: string,
  klass: McpFinding["klass"],
  severity: McpFinding["severity"],
  title: string,
  detail: string,
  evidence: McpFinding["evidence"] = {},
): McpFinding {
  return { server, klass, severity, title, detail, evidence };
}

/** Detect supply-chain / rug-pull risk: launching an UNVERSIONED remote package.
 *  An unpinned server can change behavior (or be hijacked) between runs. */
export function unpinnedServer(s: McpServerConfig): McpFinding[] {
  if (!s.command || !PACKAGE_RUNNERS.has(s.command)) return [];
  const pkg = (s.args ?? []).find((a) => !a.startsWith("-"));
  if (!pkg || isVersionPinned(pkg)) return [];
  return [
    finding(
      s.name,
      "unpinned_server",
      "high",
      "Unpinned MCP server package",
      `'${s.command} ${pkg}' launches an unversioned package; its behavior can change or be hijacked between runs (rug-pull / supply-chain). Pin a version.`,
      { command: s.command, package: pkg },
    ),
  ];
}

/** Detect a server that launches a shell or evaluates arbitrary code. */
export function dangerousCommand(s: McpServerConfig): McpFinding[] {
  if (!s.command) return [];
  const isShell = SHELL_COMMANDS.has(s.command);
  const evalFlag = (s.args ?? []).some((a) => CODE_EVAL_FLAGS.test(a));
  if (!isShell && !evalFlag) return [];
  return [
    finding(
      s.name,
      "dangerous_command",
      "high",
      "MCP server launches a shell / evaluates code",
      `Server '${s.name}' runs '${s.command}'${evalFlag ? " with an inline-eval flag" : ""}; arbitrary local code execution.`,
      { command: s.command },
    ),
  ];
}

/** Detect a hardcoded secret in env / args / headers (provider key signatures). */
export function secretInConfig(s: McpServerConfig): McpFinding[] {
  const out: McpFinding[] = [];
  const scan = (where: string, value: string) => {
    for (const { re, provider } of KEY_SIGNATURES) {
      if (re.test(value)) {
        out.push(
          finding(s.name, "secret_in_config", "critical", "Hardcoded secret in MCP config",
            `A ${provider} key is hardcoded in the ${where} of server '${s.name}'. Reference a secret store, don't inline it.`,
            { provider, location: where }),
        );
        break;
      }
    }
  };
  for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === "string") scan(`env.${k}`, v);
  for (const v of s.args ?? []) scan("args", v);
  for (const [k, v] of Object.entries(s.headers ?? {})) if (typeof v === "string") scan(`headers.${k}`, v);
  return out;
}

/** Detect an HTTP MCP server with no authorization header configured. */
export function unauthenticatedHttp(s: McpServerConfig): McpFinding[] {
  if (!s.url) return [];
  const headers = s.headers ?? {};
  const hasAuth = Object.keys(headers).some((h) => /^(authorization|x-api-key|api-key)$/i.test(h));
  if (hasAuth) return [];
  return [
    finding(
      s.name,
      "unauthenticated_http",
      "high",
      "Unauthenticated HTTP MCP server",
      `Server '${s.name}' connects over HTTP (${s.url}) with no Authorization/API-key header; anyone who can reach it can drive its tools.`,
      { url: s.url },
    ),
  ];
}

// --- tool-manifest detectors ------------------------------------------------

/** Known prompt-injection / hidden-instruction phrasings in a tool description. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)/i,
  /disregard\s+(?:the\s+)?(?:previous|above|prior|instructions)/i,
  /do\s+not\s+(?:tell|inform|mention|reveal)\s+(?:the\s+)?user/i,
  /\b(?:system|developer)\s*prompt\b/i,
  /<\s*(?:important|secret|system|instructions?)\s*>/i,
  /you\s+must\s+(?:always|never)\b/i,
  /before\s+(?:using|calling)\s+(?:any|this)\s+tool/i,
];

/** Zero-width and bidirectional control characters used to hide instructions:
 *  zero-width (200B-200F), bidi embeddings/overrides (202A-202E), word-joiner /
 *  invisible ops (2060-2064), bidi isolates (2066-2069), and the BOM (FEFF). */
const HIDDEN_UNICODE = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]");

/** Tool names/intents that grant broad, unconstrained power. */
const DANGEROUS_TOOL = /\b(exec|eval|shell|run_?command|spawn|delete_|drop_|rm_|write_file|sudo)\b/i;

/** Detect tool-poisoning + hidden-unicode + over-broad capability in a manifest. */
export function scanTools(server: string, tools: McpToolDef[]): McpFinding[] {
  const out: McpFinding[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    const desc = t.description ?? "";
    if (INJECTION_PATTERNS.some((re) => re.test(desc))) {
      out.push(finding(server, "tool_poisoning", "high", "Tool-description prompt injection",
        `Tool '${t.name}' on '${server}' has injection-style instructions in its description (the model reads this; the user usually never sees it).`,
        { tool: t.name }));
    }
    if (HIDDEN_UNICODE.test(desc) || HIDDEN_UNICODE.test(t.name)) {
      out.push(finding(server, "hidden_unicode", "high", "Hidden-character instructions in a tool",
        `Tool '${t.name}' on '${server}' contains zero-width or bidirectional characters that can hide instructions from a human reviewer.`,
        { tool: t.name }));
    }
    if (DANGEROUS_TOOL.test(t.name)) {
      out.push(finding(server, "dangerous_capability", "medium", "Broad/unconstrained MCP tool",
        `Tool '${t.name}' on '${server}' exposes an execute/delete-class capability; confirm it is least-privilege and gated.`,
        { tool: t.name }));
    }
    const key = t.name.toLowerCase();
    if (seen.has(key)) {
      out.push(finding(server, "tool_shadowing", "medium", "Duplicate tool name",
        `Tool '${t.name}' is defined more than once on '${server}'; duplicate names let one definition shadow another.`,
        { tool: t.name }));
    }
    seen.add(key);
  }
  return out;
}

const CONFIG_DETECTORS = [unpinnedServer, dangerousCommand, secretInConfig, unauthenticatedHttp];

/** All findings for one server: its config + (if supplied) its tool manifest. */
export function scanServer(s: McpServerConfig, tools?: McpToolDef[]): McpFinding[] {
  const out = CONFIG_DETECTORS.flatMap((d) => d(s));
  if (tools && tools.length) out.push(...scanTools(s.name, tools));
  return out;
}

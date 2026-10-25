import { observeRequest, withEnforcement } from "@/lib/forcefield-web/observe";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import {
  AI_TOOL_ADMIN_PROBE_PATHS,
  AI_TOOL_CONFIG_PROBE_PATHS,
  DEFAULT_RULESET,
  coerceRuleset,
  type ForcefieldRuleset,
} from "@/lib/forcefield-web/ruleset";
import { matchProbePath } from "@/lib/agent-probe-signatures";

// AI-tool config files and exploited AI-platform admin endpoints: the edge
// reports them as site.agent_probed_sensitive with a probe_class, and a
// lookalike real route never matches.
const R = DEFAULT_RULESET;
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const browser = {
  site: "coverage", method: "GET", country: "US", nowMs: 1_758_000_000_000, userAgent: CHROME_UA,
  headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-dest"],
  accept: "text/html,application/xhtml+xml", secFetchDest: "document",
};
const observe = (path: string, rs: ForcefieldRuleset = R) => observeRequest({ ...browser, path }, rs);

describe("AI-tool config file probes (probe_class ai_tool_config)", () => {
  it.each([
    ["/.cursor/mcp.json", "/.cursor"],
    ["/.cursor/mcp_config.json", "/.cursor"],
    ["/.claude/settings.json", "/.claude"],
    ["/.claude/settings.local.json", "/.claude"],
    ["/.claude/agents/reviewer.md", "/.claude"],
    ["/.claude/.credentials.json", "/.claude"],
    ["/.config/claude/.credentials.json", "/.config/claude"],
    ["/claude_desktop_config.json", "/claude_desktop_config.json"],
    ["/.mcp.json", "/.mcp"],
    ["/.mcp/config.json", "/.mcp"],
    ["/.gemini/.env", "/.gemini"],
    ["/.gemini/settings.json", "/.gemini"],
    ["/.aider.conf.yml", "/.aider"],
    ["/.aider.chat.history.md", "/.aider"],
    ["/.continue/config.json", "/.continue"],
    ["/.continue/config.yaml", "/.continue"],
    ["/.codeium/windsurf/mcp_config.json", "/.codeium"],
  ])("%s is flagged even from a real browser, matched by %s", (path, pattern) => {
    const o = observe(path)!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    expect(o.props.probe).toBe(pattern);
    expect(o.props.probe_class).toBe("ai_tool_config");
    // and the board's probe intel names it as a credential probe
    expect(matchProbePath(path)).toMatchObject({ cwe: "CWE-522", category: "ai-tool-config" });
  });

  it("/.vscode/mcp.json is still a probe (classic /.vscode pattern) and named by the intel", () => {
    const o = observe("/.vscode/mcp.json")!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    expect(o.props.probe).toBe("/.vscode");
    expect(matchProbePath("/.vscode/mcp.json")?.category).toBe("ai-tool-config");
  });
});

describe("exploited AI-platform admin endpoints (probe_class ai_tool_admin)", () => {
  it.each([
    ["/api/v1/validate/code", "/api/v1/validate/code", "CWE-94"], // Langflow CVE-2025-3248
    ["/api/v1/build_public_tmp/3fa85f64/flow", "/api/v1/build_public_tmp", "CWE-94"], // Langflow CVE-2026-33017
    ["/mcp-rest/test/connection", "/mcp-rest", "CWE-78"], // LiteLLM CVE-2026-42271
    ["/mcp-rest/test/tools/list", "/mcp-rest", "CWE-78"],
    ["/ajax-api/2.0/mlflow/registered-models/create", "/ajax-api/2.0/mlflow", "CWE-22"], // MLflow CVE-2023-1177
  ])("%s is flagged as %s", (path, pattern, cwe) => {
    const o = observe(path)!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    expect(o.props.probe).toBe(pattern);
    expect(o.props.probe_class).toBe("ai_tool_admin");
    expect(matchProbePath(path)).toMatchObject({ cwe, category: "ai-tool-admin" });
  });

  it.each(["/api/tags", "/api/pull", "/object_info", "/customnode/install/pip"])(
    "the existing Ollama / ComfyUI probe %s now carries the ai_tool_admin class",
    (path) => {
      const o = observe(path)!;
      expect(o.type).toBe("site.agent_probed_sensitive");
      expect(o.props.probe_class).toBe("ai_tool_admin");
    },
  );

  it("an LLMjacking endpoint that is not an AI-tool admin path keeps no class", () => {
    const o = observe("/v1/models")!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    expect(o.props.probe_class).toBeUndefined();
  });
});

describe("lookalike legitimate paths never match", () => {
  it.each([
    "/claude", "/blog/claude-code-tips", "/docs/claude/setup", "/.claude-notes", "/claudeai",
    "/cursor", "/products/cursor-sync", "/.cursorrules-guide",
    "/gemini", "/assets/images/embraer-e175-gemini-hires.png", "/.geminis",
    "/aider", "/aiders", "/.aiderx",
    "/continue", "/continue-reading", "/checkout/continue", "/.continued",
    "/codeium", "/mcp-servers", "/mcp-restaurant", "/mcpx",
    "/api/v1/validate", "/api/v1/validate/coder", "/api/v1/validated/code", "/api/v1/build_public",
    "/ajax-api/2.0/other", "/mlflow", "/claude_desktop_config",
  ])("%s is not a sensitive probe", (path) => {
    const o = observe(path);
    expect(o?.type ?? "none").not.toBe("site.agent_probed_sensitive");
    expect(o?.props.probe).toBeUndefined();
    expect(o?.props.probe_class).toBeUndefined();
    const intel = matchProbePath(path);
    expect(intel?.category === "ai-tool-config" || intel?.category === "ai-tool-admin").toBe(false);
  });
});

describe("enforcement follows the existing probe rules", () => {
  it("a bare AI-config probe from a browser is report-only, never a block", () => {
    const input = { path: "/.cursor/mcp.json", method: "GET", userAgent: CHROME_UA, headerNames: browser.headerNames };
    expect(decideEnforcement(input, R).block).toBe(false);
  });

  it("the same probe from a named attack tool is blocked by the attack-tool rule, and the record keeps its class", () => {
    const input = { ...browser, path: "/.gemini/.env", userAgent: "Nuclei - Open-source project (github.com/projectdiscovery/nuclei)" };
    const d = decideEnforcement(input, R);
    expect(d).toMatchObject({ block: true, reasonKind: "attack_tool" });
    const rec = withEnforcement(observeRequest(input, R), input, R, { wouldBlock: true, blocked: true, reasonKind: d.reasonKind });
    expect(rec?.props).toMatchObject({ probe: "/.gemini", probe_class: "ai_tool_config", blocked: true, action: "block" });
  });
});

describe("distribution through the central ruleset", () => {
  it("every AI pattern is in sensitivePaths and in exactly one probe class", () => {
    const classes = R.probeClasses ?? {};
    for (const p of [...AI_TOOL_CONFIG_PROBE_PATHS, ...AI_TOOL_ADMIN_PROBE_PATHS]) {
      expect(R.sensitivePaths).toContain(p);
      expect(Object.values(classes).filter((list) => list.includes(p)).length).toBe(1);
    }
    for (const list of Object.values(classes)) for (const p of list) expect(R.sensitivePaths).toContain(p);
  });

  it("sensitivePaths has no duplicates", () => {
    expect(new Set(R.sensitivePaths).size).toBe(R.sensitivePaths.length);
  });

  it("probeClasses survives coerceRuleset; a malformed class is dropped; an older ruleset without it still validates", () => {
    const c = coerceRuleset(JSON.parse(JSON.stringify({ ...R, probeClasses: { ...R.probeClasses, bad: [1] } })))!;
    expect(c.probeClasses).toEqual(R.probeClasses);
    const { probeClasses: _omit, ...older } = R;
    void _omit;
    const o = coerceRuleset(JSON.parse(JSON.stringify(older)))!;
    expect(o).not.toBeNull();
    expect(o.probeClasses).toEqual({});
    // without classes a site still reports the probe; it just carries no label
    const obs = observe("/.cursor/mcp.json", o)!;
    expect(obs.type).toBe("site.agent_probed_sensitive");
    expect(obs.props.probe_class).toBeUndefined();
  });
});

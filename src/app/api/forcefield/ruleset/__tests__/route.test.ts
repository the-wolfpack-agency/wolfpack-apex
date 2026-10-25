/** @jest-environment node */
const getCrawlerRanges = jest.fn();
jest.mock("@/lib/forcefield/crawler-ranges", () => ({ getCrawlerRanges: (...a: unknown[]) => getCrawlerRanges(...a) }));
import { GET } from "@/app/api/forcefield/ruleset/route";
import { coerceRuleset } from "@/lib/forcefield-web/ruleset";

beforeEach(() => getCrawlerRanges.mockReset().mockResolvedValue({}));

describe("GET /api/forcefield/ruleset", () => {
  it("serves the ruleset publicly and CDN-cacheable", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    const body = await res.json();
    expect(Array.isArray(body.ruleset.knownAgents)).toBe(true);
    expect(Array.isArray(body.ruleset.toolSignatures)).toBe(true);
    expect(body.ruleset.version).toBeTruthy();
  });

  it("serves verifiedAgentRanges + platformPaths that a site's coerceRuleset accepts", async () => {
    getCrawlerRanges.mockResolvedValue({ GPTBot: ["2219026944/24"] });
    const body = await (await GET()).json();
    expect(getCrawlerRanges).toHaveBeenCalledWith({ waitMs: 3000 });
    const c = coerceRuleset(body.ruleset)!;
    expect(c.verifiedAgentRanges).toEqual({ GPTBot: ["2219026944/24"] });
    expect(c.platformPaths?.wordpress).toContain("/wp-login.php");
    expect(c.sensitivePaths).toContain("/v1/models");
  });

  it("distributes the AI-tool probe paths and classes with no site code change", async () => {
    const { AI_TOOL_CONFIG_PROBE_PATHS, AI_TOOL_ADMIN_PROBE_PATHS } = await import("@/lib/forcefield-web/ruleset");
    const body = await (await GET()).json();
    // exactly what a vendored site's coerceRuleset keeps from the response
    const c = coerceRuleset(body.ruleset)!;
    for (const p of [...AI_TOOL_CONFIG_PROBE_PATHS, ...AI_TOOL_ADMIN_PROBE_PATHS]) expect(c.sensitivePaths).toContain(p);
    for (const p of ["/claude_desktop_config.json", "/.gemini", "/.aider", "/.continue", "/.codeium", "/api/v1/validate/code", "/mcp-rest", "/ajax-api/2.0/mlflow"]) expect(c.sensitivePaths).toContain(p);
    expect(c.probeClasses?.ai_tool_config).toEqual([...AI_TOOL_CONFIG_PROBE_PATHS]);
    expect(c.probeClasses?.ai_tool_admin).toEqual(expect.arrayContaining([...AI_TOOL_ADMIN_PROBE_PATHS]));
  });

  it("fails safe to an empty range map when the vendor fetch rejects", async () => {
    getCrawlerRanges.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).ruleset.verifiedAgentRanges).toEqual({});
  });
});

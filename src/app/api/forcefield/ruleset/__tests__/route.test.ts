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

  it("fails safe to an empty range map when the vendor fetch rejects", async () => {
    getCrawlerRanges.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).ruleset.verifiedAgentRanges).toEqual({});
  });
});

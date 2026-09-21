/** @jest-environment node */
import { GET } from "@/app/api/forcefield/ruleset/route";

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
});

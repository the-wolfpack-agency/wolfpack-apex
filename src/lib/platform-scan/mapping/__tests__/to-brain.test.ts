/**
 * The system map as something the assistant can answer from.
 */
import { systemMapToMarkdown } from "../to-brain";
import type { WalkedMapRow } from "../store";

const row = (over: Partial<WalkedMapRow> = {}, mapOver: Record<string, unknown> = {}): WalkedMapRow =>
  ({
    platform: "cognito-forms",
    entryUrl: "https://forms.example/acme",
    surfaceCount: 39,
    entityCount: 2,
    formCount: 13,
    frontierRemaining: 0,
    stopReason: "frontier-exhausted",
    authorizedBy: "CTO, Acme",
    generatedAt: "2026-08-30T00:00:00.000Z",
    map: {
      platform: "cognito-forms",
      entryUrl: "https://forms.example/acme",
      surfaces: [],
      entities: [
        {
          name: "Porsche CRM",
          evidence: [{ surface: "/a", kind: "form" }],
          attributes: ["centerNumber", "emailAddress"],
        },
        { name: "PCNA Users", evidence: [{ surface: "/b", kind: "nav" }], attributes: [] },
      ],
      integrations: [
        { host: "data.pendo.io", vendor: "Pendo", seenOn: ["/a", "/b"], requestCount: 124 },
        { host: "telemetry.unknown.example", vendor: null, seenOn: ["/a"], requestCount: 3 },
      ],
      paths: [],
      coverage: {
        surfacesReached: 39,
        frontierRemaining: 0,
        skipped: [],
        patterns: [{ shape: "/acme/*/publish", instances: ["a", "b", "c"], visited: 2 }],
        maxDepthReached: 3,
        stopReason: "frontier-exhausted",
        durationMs: 216_000,
      },
      generatedAt: "2026-08-30T00:00:00.000Z",
      headline: "",
      ...mapOver,
    },
    ...over,
  }) as WalkedMapRow;

describe("what the document lets somebody ask", () => {
  it("names the business objects and their fields", () => {
    const { markdown } = systemMapToMarkdown(row());
    expect(markdown).toContain("Porsche CRM");
    expect(markdown).toContain("centerNumber");
  });

  it("says where data goes, and names the vendor", () => {
    const { markdown } = systemMapToMarkdown(row());
    expect(markdown).toContain("Pendo");
    expect(markdown).toContain("124");
  });

  /* Unrecognized is a prompt to ask, not a benign default, and the wording has
     to survive being quoted on its own. */
  it("does not let an unrecognized host read as a harmless one", () => {
    const { markdown } = systemMapToMarkdown(row());
    expect(markdown).toMatch(/telemetry\.unknown\.example[\s\S]{0,160}worth asking about/);
  });

  it("says an object with no observed fields might still have some", () => {
    const { markdown } = systemMapToMarkdown(row());
    expect(markdown).toMatch(/does not mean it has none/);
  });
});

describe("a map has a date, and a system changes", () => {
  /* A retrieved chunk is quoted without its surroundings, so the caveat has to
     be inside the part worth quoting. */
  it("dates itself in the opening passage", () => {
    const { markdown } = systemMapToMarkdown(row());
    expect(markdown.slice(0, 500)).toContain("2026-08-30");
    expect(markdown.slice(0, 500)).toMatch(/snapshot, not a live view/);
  });

  it("says so when the walk did not finish", () => {
    const { markdown } = systemMapToMarkdown(
      row({ frontierRemaining: 34, stopReason: "page-budget" }),
    );
    expect(markdown).toMatch(/incomplete/);
    expect(markdown).toContain("34");
    expect(markdown).toMatch(/floor, not a total/);
  });

  it("names who authorized the walk", () => {
    expect(systemMapToMarkdown(row()).markdown).toContain("CTO, Acme");
  });

  it("says which repeated screens were sampled", () => {
    expect(systemMapToMarkdown(row()).markdown).toMatch(/sampled rather than opened/);
  });
});

describe("shape only, enforced rather than intended", () => {
  it("stores nothing sensitive even if a field label carries it", () => {
    const r = row();
    r.map.entities[0].attributes = ["centerNumber", "4111 1111 1111 1111"];
    const out = systemMapToMarkdown(r);
    expect(out.markdown).not.toContain("4111 1111 1111 1111");
    /* Non-zero is worth reporting rather than swallowing: something surprising
       was in the map. */
    expect(out.redactedCount).toBeGreaterThan(0);
  });

  it("reports nothing redacted on an ordinary map", () => {
    expect(systemMapToMarkdown(row()).redactedCount).toBe(0);
  });

  it("names the file after the platform, so a second system is a second doc", () => {
    expect(systemMapToMarkdown(row()).filename).toBe("system-map-cognito-forms.md");
  });
});

/**
 * The question that must not be answered by a severity.
 *
 * A client administering a SaaS product does not choose its embedded vendors
 * and usually does not know they are there. Asked plainly, and asked without
 * accusing anybody, because a scan cannot see whether a recording feature is
 * switched on.
 */
describe("what to ask about a vendor nobody chose", () => {
  it("carries the question next to the vendor", () => {
    const r = row();
    r.map.integrations = [
      { host: "data.pendo.io", vendor: "Pendo", seenOn: ["/a"], requestCount: 124 },
    ];
    const { markdown } = systemMapToMarkdown(r);
    expect(markdown).toMatch(/session replay/i);
    expect(markdown).toMatch(/worth asking/i);
  });

  it("says nothing extra about an ordinary vendor", () => {
    const r = row();
    r.map.integrations = [
      { host: "fonts.googleapis.com", vendor: "Google APIs", seenOn: ["/a"], requestCount: 38 },
    ];
    expect(systemMapToMarkdown(r).markdown).not.toMatch(/worth asking/i);
  });
});

/**
 * The tool the cross_source_overlap chip points at.
 *
 * The bug class this is guarding against is one we have already
 * shipped once: the product offers an action and nothing listens to it.
 * So the first test is that the chip's own wording routes here.
 */

export {};

const mockResolve = jest.fn();
jest.mock("../resolve-connector", () => ({
  resolveScopedConnector: (...a: any[]) => mockResolve(...a),
}));

const mockList = jest.fn();
jest.mock("@/lib/assistant/connectors/registry", () => ({
  listConnectors: () => mockList(),
  registerConnector: jest.fn(),
  getConnector: jest.fn(),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrack(...a) }));

const CTX: any = { userId: "u1", userRole: "admin", workspaceId: "w1" };

function system(name: string, records: any[], objectTypes = ["contact"], ok = true) {
  const connector = {
    name,
    description: name,
    isConfigured: () => true,
    objectTypes: () => objectTypes,
    searchRecords: jest.fn(async () =>
      ok ? { ok: true, data: records } : { ok: false, code: "remote_error" },
    ),
    getRecord: jest.fn(),
  };
  return connector;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockImplementation(async (_ctx: any, name: string) => ({
    connector: mockList().find((c: any) => c.name === name),
  }));
});

async function tool() {
  return (await import("../compare-across-sources-tool")).compareAcrossSourcesTool;
}

describe("it answers to the phrase the product already shows", () => {
  it("matches the chip emitted by the overlap insight", async () => {
    /* cross_source_overlap ships chip: `compare ${objectType} across
       systems`. If this ever stops matching, the product offers an
       action that does nothing. */
    const t = await tool();
    expect(t.matchIntent!("compare contact across systems")).toEqual({
      objectType: "contact",
      limit: 100,
    });
  });

  it("takes the chip the overlap generator actually builds, not a copy of it", async () => {
    /* The chip is composed at runtime from the object type. Asserting
       a hand-typed copy of it would keep passing after the generator's
       wording changed, which is exactly how the product ends up
       offering an action nothing listens to. So the real generator
       runs and its real chip is fed to the real matcher. */
    mockList.mockReturnValue([
      system("hubspot", [], ["contact", "deal"]),
      system("legacy-dms", [], ["contact"]),
    ]);
    const { generateCrossSourceOverlap } = await import(
      "@/lib/insights/source-topology"
    );
    const [overlap] = await generateCrossSourceOverlap({
      userId: "u1",
      userRole: "admin",
    });
    const chip = overlap.action!.chip!;
    const t = await tool();
    expect(t.matchIntent!(chip)).toEqual({ objectType: "contact", limit: 100 });
  });

  it.each([
    "compare contacts across systems",
    "compare our customers across both",
    "where do our systems disagree about contacts",
    "contact drift between systems",
  ])("matches %p", async (phrase) => {
    const t = await tool();
    expect(t.matchIntent!(phrase)?.objectType).toBe("contact");
  });

  it("does not fire on an object type nothing holds", async () => {
    const t = await tool();
    expect(t.matchIntent!("compare unicorns across systems")).toBeNull();
  });
});

describe("what it does with the systems it finds", () => {
  it("explains rather than fails when only one system holds the type", async () => {
    mockList.mockReturnValue([system("hubspot", [])]);
    const t = await tool();
    const res: any = await t.handler({ objectType: "contact", limit: 100 }, CTX);
    expect(res.ok).toBe(true);
    expect(res.answer).toContain("nothing to compare it against");
  });

  it("compares two systems and reports the drift", async () => {
    mockList.mockReturnValue([
      system("hubspot", [{ email: "jo@acme.com", owner: "Dana" }]),
      system("legacy-dms", [{ email: "jo@acme.com", owner: "Ray" }]),
    ]);
    const t = await tool();
    const res: any = await t.handler({ objectType: "contact", limit: 100 }, CTX);
    expect(res.ok).toBe(true);
    expect(res.data.report.matched).toBe(1);
    expect(res.answer).toContain("`owner`");
  });

  it("refuses a half comparison when one system does not answer", async () => {
    /* Every record would be reported as "only in the system that
       replied", which is worse than no answer at all. */
    mockList.mockReturnValue([
      system("hubspot", [{ email: "jo@acme.com" }]),
      system("legacy-dms", [], ["contact"], false),
    ]);
    const t = await tool();
    const res: any = await t.handler({ objectType: "contact", limit: 100 }, CTX);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("misleading");
  });

  it("skips a system the workspace scope refuses", async () => {
    /* Reading the registry directly would be a way around the gate
       every other connector tool goes through. */
    mockList.mockReturnValue([
      system("hubspot", [{ email: "jo@acme.com" }]),
      system("forbidden", [{ email: "jo@acme.com" }]),
    ]);
    mockResolve.mockImplementation(async (_c: any, name: string) =>
      name === "forbidden"
        ? { ok: false, failure: { code: "capability" } }
        : { connector: mockList().find((c: any) => c.name === name) },
    );
    const t = await tool();
    const res: any = await t.handler({ objectType: "contact", limit: 100 }, CTX);
    expect(res.data.systems).toEqual(["hubspot"]);
  });

  it("ignores a system that does not hold the object type at all", async () => {
    mockList.mockReturnValue([
      system("hubspot", [{ email: "jo@acme.com" }]),
      system("billing", [{ email: "jo@acme.com" }], ["invoice"]),
    ]);
    const t = await tool();
    const res: any = await t.handler({ objectType: "contact", limit: 100 }, CTX);
    expect(res.answer).toContain("nothing to compare it against");
  });
});

describe("what reaches analytics", () => {
  it("records the counts and none of the disagreeing values", async () => {
    /* The values are the client's customer data. They belong in the
       answer they asked for and nowhere else. */
    mockList.mockReturnValue([
      system("hubspot", [{ email: "jo@acme.com", owner: "Dana Whitfield" }]),
      system("legacy-dms", [{ email: "jo@acme.com", owner: "Ray Okonkwo" }]),
    ]);
    const t = await tool();
    await t.handler({ objectType: "contact", limit: 100 }, CTX);

    const [event, , , meta] = mockTrack.mock.calls[0];
    expect(event).toBe("assistant.cross_source_compared");
    expect(meta).toMatchObject({ matched: 1, drifting_fields: 1 });
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("Dana");
    expect(serialized).not.toContain("jo@acme.com");
  });
});

/**
 * The pipeline health endpoint: the gate, and the honest unknown.
 */
const mockGetUser = jest.fn();
const mockRead = jest.fn();

jest.mock("@/lib/auth", () => ({ getUserFromRequest: (...a: unknown[]) => mockGetUser(...a) }));
jest.mock("@/lib/brain/ingestion-health", () => ({
  readIngestionHealth: (...a: unknown[]) => mockRead(...a),
  summarizeHealth: (h: { readable: boolean; findings: unknown[] }) =>
    h.readable ? `${h.findings.length} things` : "unknown, not healthy",
}));

import { GET } from "../route";

const req = () => ({ headers: { get: () => "Bearer t" } }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto" });
  mockRead.mockResolvedValue({ takenAt: "t", readable: true, findings: [{ id: "stranded" }] });
});

describe("the gate", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetUser.mockReturnValue(null);
    expect((await GET(req())).status).toBe(401);
  });
  it("403s a role that may not read it", async () => {
    mockGetUser.mockReturnValue({ role: "sales" });
    expect((await GET(req())).status).toBe(403);
  });
  it.each(["cto", "ceo", "evp"])("200s for %s", async (role) => {
    mockGetUser.mockReturnValue({ role });
    expect((await GET(req())).status).toBe(200);
  });
});

describe("the payload", () => {
  it("carries the findings and a one-line summary", async () => {
    const body = await (await GET(req())).json();
    expect(body.findings).toHaveLength(1);
    expect(body.summary).toBe("1 things");
  });

  it("distinguishes unreadable from clean", async () => {
    /* An empty findings list from a dead database looks exactly like a healthy
       pipeline, which is the mistake the whole module exists to catch. */
    mockRead.mockResolvedValue({ takenAt: "t", readable: false, findings: [] });
    const body = await (await GET(req())).json();
    expect(body.readable).toBe(false);
    expect(body.summary).toMatch(/not healthy/);
  });

  it("is never cached", async () => {
    expect((await GET(req())).headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

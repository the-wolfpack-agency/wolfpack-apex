/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn(async () => ({
  query: mockClientQuery,
  release: mockClientRelease,
}));
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
    pool: { connect: () => mockPoolConnect() },
  };
});

import {
  getPrinciplesConfig,
  setPrinciplesConfig,
  resolvePrinciplesConfig,
} from "@/lib/principles/config";

const ORIG = { ...process.env };
beforeEach(() => {
  mockSafeQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockClear();
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.PRINCIPLES_DOC_URL;
  delete process.env.PRINCIPLES_DOC_OWNER_USER_ID;
});
afterAll(() => {
  process.env = ORIG;
});

describe("getPrinciplesConfig", () => {
  test("no row → null fields", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getPrinciplesConfig();
    expect(out.docUrl).toBeNull();
    expect(out.ownerUserId).toBeNull();
  });
  test("row → mapped record", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          doc_url: "https://sp/x",
          owner_user_id: "u1",
          updated_by: "u-cto",
          updated_at: "2026-05-01",
        },
      ],
    });
    const out = await getPrinciplesConfig();
    expect(out.docUrl).toBe("https://sp/x");
    expect(out.ownerUserId).toBe("u1");
    expect(out.updatedBy).toBe("u-cto");
  });
});

describe("setPrinciplesConfig", () => {
  test("rejects when DATABASE_URL unset", async () => {
    delete process.env.DATABASE_URL;
    await expect(
      setPrinciplesConfig({
        docUrl: "https://sp/x",
        updatedBy: "u-cto",
      }),
    ).rejects.toThrow(/DATABASE_URL/);
  });
  test("inserts when no row exists", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT existing
      .mockResolvedValueOnce({
        rows: [
          {
            doc_url: "https://sp/x",
            owner_user_id: null,
            updated_by: "u-cto",
            updated_at: "2026-05-01",
          },
        ],
      }); // INSERT
    const out = await setPrinciplesConfig({
      docUrl: "https://sp/x",
      updatedBy: "u-cto",
    });
    expect(out.docUrl).toBe("https://sp/x");
    expect(mockClientQuery.mock.calls[1][0]).toMatch(
      /INSERT INTO instinct_principles_config/,
    );
  });
  test("updates when row exists", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [
          { doc_url: "old", owner_user_id: null, updated_by: "x", updated_at: "x" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            doc_url: "new",
            owner_user_id: null,
            updated_by: "u-cto",
            updated_at: "2026-05-01",
          },
        ],
      });
    const out = await setPrinciplesConfig({
      docUrl: "new",
      updatedBy: "u-cto",
    });
    expect(out.docUrl).toBe("new");
    expect(mockClientQuery.mock.calls[1][0]).toMatch(/UPDATE instinct_principles_config/);
  });
});

describe("resolvePrinciplesConfig", () => {
  test("DB has docUrl + ownerUserId → uses both, not auto-detected", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          doc_url: "https://sp/x",
          owner_user_id: "u1",
          updated_by: null,
          updated_at: null,
        },
      ],
    });
    const out = await resolvePrinciplesConfig();
    expect(out?.docUrl).toBe("https://sp/x");
    expect(out?.ownerUserId).toBe("u1");
    expect(out?.ownerAutoDetected).toBe(false);
  });
  test("DB has docUrl only → auto-detects owner from leadership token", async () => {
    /* getPrinciplesConfig SELECT, then auto-detect SELECT (leadership join). */
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            doc_url: "https://sp/x",
            owner_user_id: null,
            updated_by: null,
            updated_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ user_id: "u-leadership" }] });
    const out = await resolvePrinciplesConfig();
    expect(out?.docUrl).toBe("https://sp/x");
    expect(out?.ownerUserId).toBe("u-leadership");
    expect(out?.ownerAutoDetected).toBe(true);
  });
  test("DB empty + env vars set → uses env fallback", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    process.env.PRINCIPLES_DOC_URL = "https://env/x";
    process.env.PRINCIPLES_DOC_OWNER_USER_ID = "u-env";
    const out = await resolvePrinciplesConfig();
    expect(out?.docUrl).toBe("https://env/x");
    expect(out?.ownerUserId).toBe("u-env");
  });
  test("nothing set → null", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const out = await resolvePrinciplesConfig();
    expect(out).toBeNull();
  });
  test("docUrl set, no owner anywhere, no token → null", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [
          {
            doc_url: "https://sp/x",
            owner_user_id: null,
            updated_by: null,
            updated_at: null,
          },
        ],
      })
      .mockRejectedValueOnce(new Error("schema mismatch")) // first auto-detect throws
      .mockResolvedValueOnce({ rows: [] }); // fallback "any token" returns nothing
    const out = await resolvePrinciplesConfig();
    expect(out).toBeNull();
  });
});

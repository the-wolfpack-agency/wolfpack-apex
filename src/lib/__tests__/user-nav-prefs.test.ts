 
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
  getNavPrefs,
  setNavPrefs,
  validateHiddenHrefs,
  KNOWN_NAV_HREFS,
  PINNED_HREFS,
} from "@/lib/user-nav-prefs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockClear();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL_DB_URL) process.env.DATABASE_URL = ORIGINAL_DB_URL;
  else delete process.env.DATABASE_URL;
});

describe("validateHiddenHrefs", () => {
  test("rejects non-array input", () => {
    expect(() => validateHiddenHrefs("foo")).toThrow(/array/);
    expect(() => validateHiddenHrefs(null)).toThrow(/array/);
  });
  test("rejects non-string entries", () => {
    expect(() => validateHiddenHrefs([1])).toThrow(/strings/);
  });
  test("rejects unknown hrefs", () => {
    expect(() => validateHiddenHrefs(["/never-existed"])).toThrow(
      /unknown nav href/,
    );
  });
  test("rejects pinned hrefs", () => {
    expect(() => validateHiddenHrefs(["/"])).toThrow(/pinned/);
    expect(() => validateHiddenHrefs(["/settings"])).toThrow(/pinned/);
  });
  test("trims, dedupes, drops empties", () => {
    expect(
      validateHiddenHrefs(["/sites", " /qr ", "/sites", "", "/qr"]),
    ).toEqual(["/sites", "/qr"]);
  });
  test("accepts an empty array", () => {
    expect(validateHiddenHrefs([])).toEqual([]);
  });
});

describe("KNOWN_NAV_HREFS", () => {
  test("matches the NAV_ITEMS array in (dashboard)/layout.tsx", () => {
    /* If a developer adds a nav entry to the layout but forgets to
       update KNOWN_NAV_HREFS, this test fails loudly so the new item
       can't silently bypass the customize-nav validator. */
    const layout = readFileSync(
      join(__dirname, "../../app/(dashboard)/layout.tsx"),
      "utf-8",
    );
    /* Match { label: "...", href: "...", ... } occurrences in NAV_ITEMS. */
    const hrefs = Array.from(
      layout.matchAll(/\{\s*label:\s*"[^"]+"\s*,\s*href:\s*"([^"]+)"/g),
    ).map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) {
      expect(KNOWN_NAV_HREFS).toContain(h);
    }
  });
  test("PINNED_HREFS is a subset of KNOWN_NAV_HREFS", () => {
    for (const p of PINNED_HREFS) {
      expect(KNOWN_NAV_HREFS).toContain(p);
    }
  });
});

describe("getNavPrefs", () => {
  test("empty userId returns default", async () => {
    const out = await getNavPrefs("");
    expect(out.hiddenHrefs).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
  test("no row returns default empty hiddenHrefs", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getNavPrefs("u1");
    expect(out.hiddenHrefs).toEqual([]);
  });
  test("existing row maps to camelCase + array", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          user_id: "u1",
          hidden_hrefs: ["/sites", "/qr"],
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const out = await getNavPrefs("u1");
    expect(out.userId).toBe("u1");
    expect(out.hiddenHrefs).toEqual(["/sites", "/qr"]);
  });
});

describe("setNavPrefs", () => {
  test("rejects when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await expect(setNavPrefs("u1", [])).rejects.toThrow(/DATABASE_URL/);
  });
  test("rejects empty userId", async () => {
    await expect(setNavPrefs("", [])).rejects.toThrow(/userId/);
  });
  test("upserts and returns mapped row", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          user_id: "u1",
          hidden_hrefs: ["/sites"],
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const out = await setNavPrefs("u1", ["/sites"]);
    expect(out.userId).toBe("u1");
    expect(out.hiddenHrefs).toEqual(["/sites"]);
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    expect(mockClientQuery.mock.calls[0][0]).toMatch(
      /INSERT INTO instinct_user_nav_prefs[\s\S]+ON CONFLICT[\s\S]+DO UPDATE/,
    );
    expect(mockClientRelease).toHaveBeenCalled();
  });
  test("validates hrefs before insert (rejects unknown)", async () => {
    await expect(setNavPrefs("u1", ["/never"])).rejects.toThrow(
      /unknown nav href/,
    );
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
  test("rejects attempts to hide pinned", async () => {
    await expect(setNavPrefs("u1", ["/"])).rejects.toThrow(/pinned/);
  });
});

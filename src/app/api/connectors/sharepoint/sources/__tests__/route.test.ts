/**
 * /api/connectors/sharepoint/sources route contract tests.
 *
 * Covers: auth gate, validation (missing name/URL, bad URL), the
 * happy-path add (parse + resolve + insert + analytics), the
 * duplicate-folder 409, and list.
 */

const mockGetUser = jest.fn();
const mockTrackEvent = jest.fn();
const mockParse = jest.fn();
const mockResolve = jest.fn();
const mockResolveShareLink = jest.fn();
const mockIsShortShareLink = jest.fn();
const mockInsertSource = jest.fn();
const mockListSources = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/sharepoint/url-parser", () => ({
  parseSharepointFolderUrl: (...a: any[]) => mockParse(...a),
  resolveSiteAndDrive: (...a: any[]) => mockResolve(...a),
}));
jest.mock("@/lib/connectors/sharepoint/resolve-share-link", () => ({
  isShortShareLink: (...a: any[]) => mockIsShortShareLink(...a),
  resolveShareLink: (...a: any[]) => mockResolveShareLink(...a),
}));
jest.mock("@/lib/connectors/sharepoint/repo", () => ({
  createRepo: () => ({
    insertSource: mockInsertSource,
    listSources: mockListSources,
  }),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/connectors/sharepoint/sources/route";

function req(body?: unknown, method: "GET" | "POST" = "POST"): NextRequest {
  /* NextRequest's RequestInit is stricter than the DOM one (signal
   * cannot be null). We avoid that conflict by building a plain
   * Request then wrapping. */
  const init: RequestInit = {
    method,
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new NextRequest(
    new Request(new URL("http://x/api/connectors/sharepoint/sources"), init),
  );
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockTrackEvent.mockReset();
  mockParse.mockReset();
  mockResolve.mockReset();
  mockResolveShareLink.mockReset();
  mockIsShortShareLink.mockReset();
  mockInsertSource.mockReset();
  mockListSources.mockReset();
  /* Default: URL is canonical, not a short share link. Specific tests
   * override mockIsShortShareLink + mockResolveShareLink to exercise
   * the share-link fallback path. */
  mockIsShortShareLink.mockReturnValue(false);
});

describe("POST /api/connectors/sharepoint/sources", () => {
  test("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req({ name: "x", siteUrl: "https://x" }));
    expect(res.status).toBe(401);
  });

  test("400 when name missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
    const res = await POST(req({ siteUrl: "https://x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("name_required");
  });

  test("400 when siteUrl missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
    const res = await POST(req({ name: "PCNA" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("site_url_required");
  });

  test("400 when URL is unparseable", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
    mockParse.mockReturnValue(null);
    const res = await POST(req({ name: "PCNA", siteUrl: "not a url" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/couldn't parse/i);
  });

  test("400 with friendly message when resolve fails (no_token)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
    mockParse.mockReturnValue({ site_host: "x", site_path: "sites/X", folder_path: "Shared Documents" });
    mockResolve.mockResolvedValue({ ok: false, error: { kind: "no_token" } });
    const res = await POST(req({ name: "PCNA", siteUrl: "https://x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Microsoft account isn't connected/);
  });

  test("happy path: parses, resolves, inserts, fires analytics, returns 201", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockParse.mockReturnValue({ site_host: "x.sharepoint.com", site_path: "sites/PCNAINTERNAL", folder_path: "Shared Documents/Program Evals" });
    mockResolve.mockResolvedValue({
      ok: true,
      resolved: { site_id: "S", drive_id: "D", folder_path: "Shared Documents/Program Evals" },
    });
    const fakeSource = {
      id: "src-1", workspaceId: "ws1", name: "PCNA", siteUrl: "https://x",
      siteId: "S", driveId: "D", folderPath: "Shared Documents/Program Evals",
      createdBy: "u1", createdAt: "now", lastSyncedAt: null, isActive: true,
    };
    mockInsertSource.mockResolvedValue(fakeSource);
    const res = await POST(req({ name: "PCNA", siteUrl: "https://x/sites/PCNAINTERNAL" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source).toEqual(fakeSource);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "connectors.sharepoint.source_added", "u1", "cto",
      expect.objectContaining({ source_id: "src-1", workspace_id: "ws1" }),
    );
  });

  test("short share link (:f:/s/) is auto-resolved via Graph before parsing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    /* First parse attempt on the raw short link fails. */
    mockParse.mockReturnValueOnce(null);
    mockIsShortShareLink.mockReturnValue(true);
    mockResolveShareLink.mockResolvedValue({
      ok: true,
      webUrl: "https://x.sharepoint.com/sites/PCNAINTERNAL/Shared%20Documents/Program%20Evals",
      driveId: "D",
      itemId: "I",
    });
    /* Second parse attempt on the resolved canonical URL succeeds. */
    mockParse.mockReturnValueOnce({
      site_host: "x.sharepoint.com",
      site_path: "sites/PCNAINTERNAL",
      folder_path: "Shared Documents/Program Evals",
    });
    mockResolve.mockResolvedValue({
      ok: true,
      resolved: { site_id: "S", drive_id: "D", folder_path: "Shared Documents/Program Evals" },
    });
    mockInsertSource.mockResolvedValue({
      id: "src-1", workspaceId: "ws1", name: "PCNA Evals",
      siteUrl: "https://x.sharepoint.com/sites/PCNAINTERNAL/Shared%20Documents/Program%20Evals",
      siteId: "S", driveId: "D", folderPath: "Shared Documents/Program Evals",
      createdBy: "u1", createdAt: "now", lastSyncedAt: null, isActive: true,
    });

    const res = await POST(req({
      name: "PCNA Evals",
      siteUrl: "https://x.sharepoint.com/:f:/s/PCNAINTERNAL/abc123",
    }));
    expect(res.status).toBe(201);
    /* Stored siteUrl is the canonical webUrl, NOT the short share token,
     * so the row survives share-token expiry. */
    expect(mockInsertSource).toHaveBeenCalledWith(
      expect.objectContaining({
        siteUrl: "https://x.sharepoint.com/sites/PCNAINTERNAL/Shared%20Documents/Program%20Evals",
      }),
    );
  });

  test("short share link + no_token error → friendly 'connect Outlook' message", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
    mockParse.mockReturnValue(null);
    mockIsShortShareLink.mockReturnValue(true);
    mockResolveShareLink.mockResolvedValue({ ok: false, error: "no_token" });
    const res = await POST(req({
      name: "PCNA",
      siteUrl: "https://x.sharepoint.com/:f:/s/X/abc",
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Microsoft account isn't connected/);
  });

  test("409 on duplicate folder (pg unique-index violation)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto" });
    mockParse.mockReturnValue({ site_host: "x", site_path: "sites/X", folder_path: "Shared Documents" });
    mockResolve.mockResolvedValue({ ok: true, resolved: { site_id: "S", drive_id: "D", folder_path: "Shared Documents" } });
    const err: any = new Error("unique constraint");
    err.code = "23505";
    mockInsertSource.mockRejectedValue(err);
    const res = await POST(req({ name: "PCNA", siteUrl: "https://x" }));
    expect(res.status).toBe(409);
  });
});

describe("GET /api/connectors/sharepoint/sources", () => {
  test("returns sources for the user's workspace", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", workspaceId: "ws1" });
    mockListSources.mockResolvedValue([{ id: "s1" }]);
    const res = await GET(req(undefined, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toEqual([{ id: "s1" }]);
    expect(mockListSources).toHaveBeenCalledWith("ws1");
  });

  test("401 unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(req(undefined, "GET"));
    expect(res.status).toBe(401);
  });
});

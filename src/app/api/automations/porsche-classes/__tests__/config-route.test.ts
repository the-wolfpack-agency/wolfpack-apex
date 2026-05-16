/**
 * Contract tests for /api/automations/porsche-classes/config and the
 * /sharepoint-test sub-route.
 *
 * Each route is exercised for:
 *   - 401 (no auth)
 *   - 403 (capability missing)
 *   - happy path with the typed JSON body the wizard sends
 *   - one common error path per route (invalid URL, etc.)
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockGetInboxFilters = jest.fn();
const mockGetSharepointConfig = jest.fn();
const mockSetInboxFilters = jest.fn();
const mockSetSharepointConfig = jest.fn();
jest.mock("@/lib/automations/porsche-classes/config-repo", () => ({
  getInboxFilters: (...a: unknown[]) => mockGetInboxFilters(...a),
  getSharepointConfig: (...a: unknown[]) => mockGetSharepointConfig(...a),
  setInboxFilters: (...a: unknown[]) => mockSetInboxFilters(...a),
  setSharepointConfig: (...a: unknown[]) => mockSetSharepointConfig(...a),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
}));

const mockResolveSiteAndDrive = jest.fn();
jest.mock("@/lib/sharepoint/url-parser", () => {
  const actual = jest.requireActual("@/lib/sharepoint/url-parser");
  return {
    ...actual,
    resolveSiteAndDrive: (...a: unknown[]) => mockResolveSiteAndDrive(...a),
  };
});

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import {
  GET as configGET,
  PUT as configPUT,
} from "@/app/api/automations/porsche-classes/config/route";
import { POST as sharepointTestPOST } from "@/app/api/automations/porsche-classes/config/sharepoint-test/route";

function req(method: string, body?: unknown): NextRequest {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new NextRequest(
    "http://x/api/automations/porsche-classes/config",
    init,
  );
}

function allow(role = "ops", userId = "u-1", email = "alicia@example.com") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: userId, email, name: email, role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function deny(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  /* Sensible defaults so happy-path tests don't have to spell out
     every dependency. */
  mockGetInboxFilters.mockResolvedValue({
    sender_match: ["porsche-academy-notification@porsche.de"],
    subject_match: ["Scheduled Report Notification"],
  });
  mockGetSharepointConfig.mockResolvedValue(null);
  mockGetValidToken.mockResolvedValue({
    accessToken: "tok",
    userEmail: "alicia@example.com",
  });
});

/* ------------------------------------------------------------------ */
/* GET /config                                                         */
/* ------------------------------------------------------------------ */

describe("GET /api/automations/porsche-classes/config", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await configGET(req("GET"));
    expect(r.status).toBe(401);
  });

  it("403 when capability missing", async () => {
    deny(403, "forbidden");
    const r = await configGET(req("GET"));
    expect(r.status).toBe(403);
  });

  it("200 returns inbox_filters + sharepoint + status flags", async () => {
    allow();
    const r = await configGET(req("GET"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      inbox_filters: { sender_match: string[] };
      sharepoint: unknown;
      status: {
        graph_connected: boolean;
        inbox_filter_set: boolean;
        sharepoint_set: boolean;
      };
    };
    expect(body.inbox_filters.sender_match).toContain(
      "porsche-academy-notification@porsche.de",
    );
    expect(body.sharepoint).toBeNull();
    expect(body.status.graph_connected).toBe(true);
    expect(body.status.inbox_filter_set).toBe(true);
    expect(body.status.sharepoint_set).toBe(false);
  });

  it("status.graph_connected reflects getValidToken === null", async () => {
    allow();
    mockGetValidToken.mockResolvedValueOnce(null);
    const r = await configGET(req("GET"));
    const body = (await r.json()) as { status: { graph_connected: boolean } };
    expect(body.status.graph_connected).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* PUT /config                                                         */
/* ------------------------------------------------------------------ */

describe("PUT /api/automations/porsche-classes/config", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await configPUT(req("PUT", { inbox_filters: { sender_match: [], subject_match: [] } }));
    expect(r.status).toBe(401);
  });

  it("400 when body has neither inbox_filters nor sharepoint", async () => {
    allow();
    const r = await configPUT(req("PUT", {}));
    expect(r.status).toBe(400);
  });

  it("400 when sender_match isn't a string array", async () => {
    allow();
    const r = await configPUT(
      req("PUT", { inbox_filters: { sender_match: "abc", subject_match: [] } }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/list of email addresses/);
  });

  it("happy path — saves inbox_filters and returns fresh status", async () => {
    allow();
    mockSetInboxFilters.mockResolvedValueOnce(undefined);
    const r = await configPUT(
      req("PUT", {
        inbox_filters: {
          sender_match: ["a@x.com", "b@x.com"],
          subject_match: ["Hello"],
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(mockSetInboxFilters).toHaveBeenCalledTimes(1);
    expect(mockSetInboxFilters.mock.calls[0][0]).toEqual({
      sender_match: ["a@x.com", "b@x.com"],
      subject_match: ["Hello"],
    });
    expect(mockSetInboxFilters.mock.calls[0][1]).toBe("alicia@example.com");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.config_updated",
      "u-1",
      "ops",
      expect.objectContaining({
        automation_id: "porsche-classes",
        fields: "inbox_filters",
      }),
    );
  });

  it("400 when sharepoint URL is unparseable", async () => {
    allow();
    const r = await configPUT(
      req("PUT", { sharepoint: { url: "not a url" } }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/SharePoint folder/);
    expect(mockSetSharepointConfig).not.toHaveBeenCalled();
  });

  it("happy path — saves sharepoint via parsed URL + Graph resolve", async () => {
    allow();
    mockResolveSiteAndDrive.mockResolvedValueOnce({
      ok: true,
      resolved: {
        site_id: "contoso.sharepoint.com,abc,def",
        drive_id: "drive-1",
        folder_path: "SubFolder",
      },
    });
    mockSetSharepointConfig.mockResolvedValueOnce(undefined);
    const r = await configPUT(
      req("PUT", {
        sharepoint: {
          url:
            "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/SubFolder",
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(mockSetSharepointConfig).toHaveBeenCalledWith(
      {
        site_id: "contoso.sharepoint.com,abc,def",
        drive_id: "drive-1",
        path: "SubFolder",
      },
      "alicia@example.com",
    );
  });

  it("happy path — saves sharepoint via pre-resolved triple", async () => {
    allow();
    mockSetSharepointConfig.mockResolvedValueOnce(undefined);
    const r = await configPUT(
      req("PUT", {
        sharepoint: {
          site_id: "contoso.sharepoint.com,abc,def",
          drive_id: "drive-1",
          path: "PCNA/Summaries",
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(mockSetSharepointConfig).toHaveBeenCalledTimes(1);
    expect(mockResolveSiteAndDrive).not.toHaveBeenCalled();
  });

  it("plain-language error when Graph resolve returns no_token", async () => {
    allow();
    mockResolveSiteAndDrive.mockResolvedValueOnce({
      ok: false,
      error: { kind: "no_token" },
    });
    const r = await configPUT(
      req("PUT", {
        sharepoint: {
          url:
            "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/SubFolder",
        },
      }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("outlook");
  });
});

/* ------------------------------------------------------------------ */
/* POST /config/sharepoint-test                                        */
/* ------------------------------------------------------------------ */

describe("POST /api/automations/porsche-classes/config/sharepoint-test", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await sharepointTestPOST(req("POST"));
    expect(r.status).toBe(401);
  });

  it("400 when no sharepoint config has been saved", async () => {
    allow();
    mockGetSharepointConfig.mockResolvedValueOnce(null);
    const r = await sharepointTestPOST(req("POST"));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Step 3/);
  });

  it("400 when no Microsoft token is available", async () => {
    allow();
    mockGetSharepointConfig.mockResolvedValueOnce({
      site_id: "abc",
      drive_id: "drive-1",
      path: "Folder",
    });
    mockGetValidToken.mockResolvedValueOnce(null);
    const r = await sharepointTestPOST(req("POST"));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.error.toLowerCase()).toContain("outlook");
  });

  it("ok=true when Graph returns 200", async () => {
    allow();
    mockGetSharepointConfig.mockResolvedValueOnce({
      site_id: "abc",
      drive_id: "drive-1",
      path: "Folder",
    });
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ id: "x" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await sharepointTestPOST(req("POST"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("ok=false with friendly 404 message when Graph returns 404", async () => {
    allow();
    mockGetSharepointConfig.mockResolvedValueOnce({
      site_id: "abc",
      drive_id: "drive-1",
      path: "Folder",
    });
    global.fetch = jest.fn(async () =>
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    const r = await sharepointTestPOST(req("POST"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error.toLowerCase()).toContain("folder");
  });
});

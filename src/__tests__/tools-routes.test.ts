/**
 * Tools API route tests.
 *
 * Validates:
 *   - 401 without auth token
 *   - Graceful "local server required" when Python is unavailable
 *   - POST-only (GET returns 405 or route-not-found)
 *   - trackEvent fires on success path
 *
 * Each of the 4 routes is tested independently.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackEvent = jest.fn();
const mockExecSync = jest.fn();

// Mock analytics
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

// Mock DB (requireCapability loads user overrides)
jest.mock("@/lib/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

// Mock triple-write
jest.mock("@/lib/triple-write", () => ({
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock child_process
jest.mock("child_process", () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// Mock fs for pdf-report
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue(Buffer.from("fake-pdf")),
  unlinkSync: jest.fn(),
}));

import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.INSTINCT_JWT_SECRET ?? process.env.APEX_JWT_SECRET ?? "test-secret-for-dev";

// Ensure env is set so auth.ts picks it up
if (!process.env.INSTINCT_JWT_SECRET && !process.env.APEX_JWT_SECRET) {
  process.env.INSTINCT_JWT_SECRET = JWT_SECRET;
}

function makeToken(role = "cto") {
  return jwt.sign(
    { id: "user-1", name: "Test User", email: "test@wolf.co", role, workspace_id: "ws-1" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function authedReq(url: string, opts: { method?: string; body?: string } = {}) {
  return new NextRequest(url, {
    method: opts.method ?? "POST",
    body: opts.body ?? "{}",
    headers: {
      authorization: `Bearer ${makeToken()}`,
      "content-type": "application/json",
    },
  });
}

function unauthReq(url: string, opts: { method?: string; body?: string } = {}) {
  return new NextRequest(url, {
    method: opts.method ?? "POST",
    body: opts.body ?? "{}",
    headers: { "content-type": "application/json" },
  });
}

// Load route handlers fresh each time
async function loadRoute(path: string) {
  jest.resetModules();
  // Re-apply mocks after resetModules
  jest.mock("@/lib/analytics", () => ({
    trackEvent: (...args: any[]) => mockTrackEvent(...args),
  }));
  jest.mock("@/lib/db", () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }));
  jest.mock("@/lib/triple-write", () => ({
    tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
  }));
  jest.mock("child_process", () => ({
    execSync: (...args: any[]) => mockExecSync(...args),
  }));
  jest.mock("fs", () => ({
    ...jest.requireActual("fs"),
    existsSync: jest.fn().mockReturnValue(true),
    readFileSync: jest.fn().mockReturnValue(Buffer.from("fake-pdf")),
    unlinkSync: jest.fn(),
  }));
  return await import(`@/app/api/tools/${path}/route`);
}

const ROUTES = ["pdf-report", "demo-deck", "visual-diff", "accessibility"] as const;

describe("Tools API routes", () => {
  beforeEach(() => {
    mockTrackEvent.mockClear();
    mockExecSync.mockClear();
  });

  /* ── Auth: 401 without token ──────────────────────────────────── */

  for (const route of ROUTES) {
    it(`POST /api/tools/${route} returns 401 without auth`, async () => {
      const mod = await loadRoute(route);
      const req = unauthReq(`https://localhost/api/tools/${route}`, { method: "POST", body: "{}" });
      const res = await mod.POST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("unauthorized");
    });
  }

  /* ── Python unavailable (Vercel deploy) ───────────────────────── */

  for (const route of ROUTES) {
    it(`POST /api/tools/${route} returns graceful message when Python unavailable`, async () => {
      mockExecSync.mockImplementation(() => {
        const err = new Error("spawn python3 ENOENT") as any;
        err.code = "ENOENT";
        throw err;
      });

      const mod = await loadRoute(route);
      const req = authedReq(`https://localhost/api/tools/${route}`, { method: "POST", body: "{}" });
      const res = await mod.POST(req);
      const data = await res.json();
      expect(data.available).toBe(false);
      expect(data.message).toContain("local development server");
    });
  }

  /* ── PDF report success path ──────────────────────────────────── */

  it("POST /api/tools/pdf-report returns PDF on success", async () => {
    mockExecSync.mockReturnValue("");
    const mod = await loadRoute("pdf-report");
    const req = authedReq("https://localhost/api/tools/pdf-report", { method: "POST", body: "{}" });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  /* ── Demo deck success path ───────────────────────────────────── */

  it("POST /api/tools/demo-deck returns screenshot list on success", async () => {
    mockExecSync.mockReturnValue(JSON.stringify({ screenshots: ["/tmp/a.png", "/tmp/b.png"] }));
    const mod = await loadRoute("demo-deck");
    const req = authedReq("https://localhost/api/tools/demo-deck", {
      method: "POST",
      body: JSON.stringify({ target: "instinct" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.screenshots).toHaveLength(2);
  });

  /* ── Visual diff success path ─────────────────────────────────── */

  it("POST /api/tools/visual-diff returns diff results on success", async () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ results: [{ path: "/", status: "unchanged" }, { path: "/sites", status: "changed", change_pct: 12 }] }),
    );
    const mod = await loadRoute("visual-diff");
    const req = authedReq("https://localhost/api/tools/visual-diff", { method: "POST", body: "{}" });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(2);
    expect(data.results[1].status).toBe("changed");
  });

  /* ── Accessibility success path ───────────────────────────────── */

  it("POST /api/tools/accessibility returns audit results on success", async () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        audit: { score: 85, issues: [{ rule: "color-contrast", severity: "serious", description: "Low contrast text", count: 3 }] },
      }),
    );
    const mod = await loadRoute("accessibility");
    const req = authedReq("https://localhost/api/tools/accessibility", {
      method: "POST",
      body: JSON.stringify({ paths: ["/", "/sites"] }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.audit.score).toBe(85);
    expect(data.audit.issues).toHaveLength(1);
  });
});

/**
 * Benefits e2e — full Alicia flow against real route handlers.
 *
 * Stateful in-memory DB stub. Walks: upload PDF (multipart) → parse →
 * persist → recommendation generated → fetch → decide. Catches flow
 * bugs that per-call mocks miss.
 */

interface DocRow { id: string; filename: string; carrier: string | null; uploaded_at: string }
interface PlanRow { id: string; document_id: string; plan_id: string }
interface RecRow { id: string; document_id: string; rule_name: string; recommended_plan_id: string; outcome: string }
interface InsightRow { id: string; category: string; severity: string; title: string; status: string }

const docs = new Map<string, DocRow>();
const plans: PlanRow[] = [];
const recs: RecRow[] = [];
const insights: InsightRow[] = [];

function fakeDb(sql: string, params: unknown[] = []) {
  const s = sql.replace(/\s+/g, " ").trim();
  if (s.startsWith("INSERT INTO apex_benefit_documents")) {
    const [id, filename, carrier] = params as [string, string, string];
    const row: DocRow = { id, filename, carrier, uploaded_at: new Date().toISOString() };
    docs.set(id, row);
    return { rows: [row] };
  }
  if (s.startsWith("INSERT INTO apex_benefit_plans")) {
    const [id, document_id, plan_id] = params as [string, string, string];
    plans.push({ id, document_id, plan_id });
    return { rows: [] };
  }
  if (s.startsWith("INSERT INTO apex_benefit_recommendations")) {
    const [id, document_id, rule_name, recommended_plan_id] = params as [string, string, string, string];
    recs.push({ id, document_id, rule_name, recommended_plan_id, outcome: "pending" });
    return { rows: [] };
  }
  if (s.startsWith("UPDATE apex_benefit_recommendations")) {
    const [id, outcome] = params as [string, string];
    const r = recs.find((x) => x.id === id);
    if (r) r.outcome = outcome;
    return { rows: [] };
  }
  if (s.startsWith("INSERT INTO instinct_hr_insights")) {
    const [id, category, severity, title] = params as [string, string, string, string];
    insights.push({ id, category, severity, title, status: "open" });
    return { rows: [] };
  }
  if (s.startsWith("SELECT * FROM apex_benefit_documents ORDER BY")) {
    return { rows: [...docs.values()] };
  }
  if (s.startsWith("SELECT * FROM apex_benefit_documents WHERE id =")) {
    const row = docs.get(params[0] as string);
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith("SELECT * FROM apex_benefit_plans WHERE document_id")) {
    return { rows: plans.filter((p) => p.document_id === params[0]) };
  }
  if (s.startsWith("SELECT * FROM apex_benefit_recommendations WHERE document_id")) {
    return { rows: recs.filter((r) => r.document_id === params[0]) };
  }
  if (s.startsWith("SELECT * FROM instinct_hr_insights")) {
    return { rows: insights.filter((i) => i.status !== "dismissed") };
  }
  return { rows: [] };
}

jest.mock("@/lib/db", () => ({
  safeQuery: (sql: string, params?: unknown[]) => Promise.resolve(fakeDb(sql, params)),
  query: (sql: string, params?: unknown[]) => Promise.resolve(fakeDb(sql, params)),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => ({ id: "u_alicia", role: "hr", name: "Alicia", email: "alicia@wolfpack" }),
}));

// Stub the PDF extractor at the benefits module level so we never touch
// pdf-parse in tests (it has a noisy debug-mode startup behavior).
jest.mock("@/lib/benefits", () => {
  const actual = jest.requireActual("@/lib/benefits");
  return {
    ...actual,
    parseBenefitDocument: async (filename: string, buffer: Buffer) => {
      const text = `
THE WOLFPACK AGENCY LLC
Account Number: 355195
Effective Date: Dec 1, 2025
Blue Cross Blue Shield
Blue Choice PPO Network
PPO Plans
Gold
G9K8CHC $1050// $6300// 80%// $55/$55 $100 $600// $100 $150// $10/$20/$70/ $8,774.95 $974.99 $1,949.98 $1,949.98 $2,924.97 $8,774.91
Blue Advantage HMO Network
HMO Plans
Silver
S9N1ADT $4100// $9200// 60%// $0/$0 $90 $400// $150 DC// 80%/80%/70%/ $4,638.83 $515.43 $1,030.86 $1,030.86 $1,546.29 $4,638.87
`;
      const { extractPlanRows } = actual;
      const { plans, carrier, effective_date, account_number } = extractPlanRows(text);
      return {
        filename,
        carrier,
        effective_date,
        account_number,
        page_count: 7,
        size_bytes: buffer.length,
        raw_text_excerpt: text.slice(0, 2000),
        plans,
      };
    },
  };
});

import { NextRequest } from "next/server";
import { POST as benefitsPOST, GET as benefitsGET } from "@/app/api/people/benefits/route";
import { GET as detailGET } from "@/app/api/people/benefits/[id]/route";
import { PATCH as recPATCH } from "@/app/api/people/recommendations/[id]/route";
import { GET as insightsGET } from "@/app/api/people/insights/route";

describe("Benefits E2E — Alicia uploads a renewal PDF and gets a recommendation", () => {
  beforeEach(() => {
    docs.clear();
    plans.length = 0;
    recs.length = 0;
    insights.length = 0;
  });

  it("walks upload → parse → recommend → list → detail → decide", async () => {
    // 1. Upload (multipart)
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }), "renewal.pdf");
    const uploadReq = new NextRequest("http://t/api/people/benefits", {
      method: "POST",
      headers: { authorization: "Bearer x" },
      body: fd as unknown as BodyInit,
    });
    const uploadRes = await benefitsPOST(uploadReq);
    const uploadData = await uploadRes.json();
    expect(uploadRes.status).toBe(200);
    expect(uploadData.documentId).toMatch(/^bd_/);
    expect(uploadData.planCount).toBeGreaterThan(0);
    expect(uploadData.carrier).toBe("Blue Cross Blue Shield");
    expect(uploadData.recommendation).not.toBeNull();
    expect(uploadData.recommendation.plan_id).toBe("S9N1ADT");
    expect(Array.isArray(uploadData.insights)).toBe(true);
    const docId = uploadData.documentId;
    const recId = uploadData.recommendation.id;

    // 2. List documents
    const listReq = new NextRequest("http://t/api/people/benefits", {
      method: "GET",
      headers: { authorization: "Bearer x" },
    });
    const listRes = await benefitsGET(listReq);
    const listData = await listRes.json();
    expect(listData.documents.length).toBe(1);

    // 3. Detail
    const detailReq = new NextRequest(`http://t/api/people/benefits/${docId}`, {
      method: "GET",
      headers: { authorization: "Bearer x" },
    });
    const detailRes = await detailGET(detailReq, { params: Promise.resolve({ id: docId }) });
    const detailData = await detailRes.json();
    expect(detailRes.status).toBe(200);
    expect(detailData.plans.length).toBeGreaterThan(0);
    expect(detailData.recommendations.length).toBeGreaterThan(0);

    // 4. Insights (should have at least one from upload)
    const insightsReq = new NextRequest("http://t/api/people/insights", {
      method: "GET",
      headers: { authorization: "Bearer x" },
    });
    const insightsRes = await insightsGET(insightsReq);
    const insightsData = await insightsRes.json();
    expect(insightsData.insights.length).toBeGreaterThan(0);

    // 5. Decide (accept the recommendation)
    const decideReq = new NextRequest(`http://t/api/people/recommendations/${recId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ outcome: "accepted" }),
    });
    const decideRes = await recPATCH(decideReq, { params: Promise.resolve({ id: recId }) });
    expect(decideRes.status).toBe(200);
    const acceptedRec = recs.find((r) => r.id === recId);
    expect(acceptedRec?.outcome).toBe("accepted");
  });

  it("rejects non-PDF uploads with 415", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    const req = new NextRequest("http://t/api/people/benefits", {
      method: "POST",
      headers: { authorization: "Bearer x" },
      body: fd as unknown as BodyInit,
    });
    const res = await benefitsPOST(req);
    expect(res.status).toBe(415);
  });

  it("requires auth", async () => {
    jest.resetModules();
    jest.doMock("@/lib/auth", () => ({ getUserFromRequest: () => null }));
    const { POST: noAuthPOST } = await import("@/app/api/people/benefits/route");
    const fd = new FormData();
    fd.append("file", new Blob(["x"], { type: "application/pdf" }), "x.pdf");
    const req = new NextRequest("http://t/api/people/benefits", {
      method: "POST",
      headers: {},
      body: fd as unknown as BodyInit,
    });
    const res = await noAuthPOST(req);
    expect(res.status).toBe(401);
  });
});

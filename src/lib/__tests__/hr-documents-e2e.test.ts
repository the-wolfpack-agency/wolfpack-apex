/**
 * HR Documents end-to-end integration test.
 *
 * Walks the smart-router flow against the real route handler with a
 * stateful in-memory DB stub:
 *   1. Upload a W-4 to /api/people/documents
 *   2. Verify it's stored in instinct_hr_documents with category=w4
 *   3. Upload a benefits renewal — verify it's stored AND the
 *      benefits pipeline ran (instinct_benefit_documents row + plans + rec)
 *   4. List documents (filter by category)
 *   5. Recategorize a doc
 *   6. Delete a doc
 */

interface HrDocRow { id: string; filename: string; category: string; size_bytes: number; status: string; uploaded_at: string }
interface BenefitDocRow { id: string }
interface BenefitPlanRow { id: string; document_id: string; plan_id: string }
interface BenefitRecRow { id: string; document_id: string }

const hrDocs = new Map<string, HrDocRow>();
const benefitDocs = new Map<string, BenefitDocRow>();
const benefitPlans: BenefitPlanRow[] = [];
const benefitRecs: BenefitRecRow[] = [];

function fakeDb(sql: string, params: unknown[] = []) {
  const s = sql.replace(/\s+/g, " ").trim();
  // INSERT into instinct_hr_documents
  if (s.startsWith("INSERT INTO instinct_hr_documents")) {
    const [id, filename, , size_bytes, , category] = params as [string, string, string, number, number, string];
    hrDocs.set(id, { id, filename, category, size_bytes, status: "active", uploaded_at: new Date().toISOString() });
    return { rows: [] };
  }
  if (s.startsWith("SELECT * FROM instinct_hr_documents WHERE id =")) {
    const r = hrDocs.get(params[0] as string);
    return { rows: r ? [r] : [] };
  }
  if (s.startsWith("SELECT * FROM instinct_hr_documents WHERE status")) {
    let results = [...hrDocs.values()];
    // Handle combined filters: category and/or employee_id after status = 'active'
    if (s.includes("category =")) {
      const catIdx = params.findIndex((p) => typeof p === "string" && !p.startsWith("emp_"));
      if (catIdx >= 0) results = results.filter((r) => r.category === params[catIdx]);
    }
    return { rows: results };
  }
  if (s.startsWith("UPDATE instinct_hr_documents SET category")) {
    const [id, category] = params as [string, string];
    const r = hrDocs.get(id);
    if (!r) return { rows: [] };
    r.category = category;
    return { rows: [r] };
  }
  if (s.startsWith("UPDATE instinct_hr_documents SET employee_id")) {
    const id = params[0] as string;
    const r = hrDocs.get(id);
    if (!r) return { rows: [] };
    return { rows: [r] };
  }
  if (s.startsWith("DELETE FROM instinct_hr_documents")) {
    const id = params[0] as string;
    const had = hrDocs.has(id);
    hrDocs.delete(id);
    return { rows: had ? [{ id }] : [] };
  }
  // benefits side-effects
  if (s.startsWith("INSERT INTO instinct_benefit_documents")) {
    const [id] = params as [string];
    benefitDocs.set(id, { id });
    return { rows: [] };
  }
  if (s.startsWith("INSERT INTO instinct_benefit_plans")) {
    const [id, document_id, plan_id] = params as [string, string, string];
    benefitPlans.push({ id, document_id, plan_id });
    return { rows: [] };
  }
  if (s.startsWith("INSERT INTO instinct_benefit_recommendations")) {
    const [id, document_id] = params as [string, string];
    benefitRecs.push({ id, document_id });
    return { rows: [] };
  }
  if (s.startsWith("INSERT INTO instinct_hr_insights")) {
    return { rows: [] };
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

// Stub the PDF extractor at the benefits module so we never touch
// unpdf in tests
jest.mock("@/lib/benefits", () => {
  const actual = jest.requireActual("@/lib/benefits");
  return {
    ...actual,
    parseBenefitDocument: async (filename: string, buffer: Buffer) => {
      // Pick fixture text from filename
      let text = "";
      if (/w4/i.test(filename)) {
        text = `Form W-4 2026
Employee's Withholding Certificate
Department of the Treasury
Internal Revenue Service
Step 1: Enter Personal Information
Multiple Jobs Worksheet`;
      } else if (/i9/i.test(filename)) {
        text = `Form I-9 Employment Eligibility Verification
USCIS U.S. Citizenship and Immigration Services
List A   List B    List C`;
      } else if (/renewal|bcbs/i.test(filename)) {
        text = `THE WOLFPACK AGENCY LLC
Renewal Effective Date: Dec 1, 2025
Blue Cross Blue Shield
Blue Choice PPO Network
PPO Plans
Gold
G9K8CHC $1050//
$2100
$6300//
Unlimited
80%//
60%
$55/$55 $100 $600//
80%
$100 $150//
$250
$10/$20/$70/
$120/$150/$250
$8,774.95 $974.99 $1,949.98 $1,949.98 $2,924.97 $8,774.91`;
      } else {
        text = "random non-HR content";
      }
      const { extractPlanRows } = actual;
      const { plans, carrier, effective_date, account_number } = extractPlanRows(text);
      return {
        filename,
        carrier,
        effective_date,
        account_number,
        page_count: 1,
        size_bytes: buffer.length,
        raw_text_excerpt: text.slice(0, 2000),
        plans,
      };
    },
  };
});

import { NextRequest } from "next/server";
import { POST as docsPOST, GET as docsGET } from "@/app/api/people/documents/route";
import { GET as docDetailGET, PATCH as docDetailPATCH, DELETE as docDetailDELETE } from "@/app/api/people/documents/[id]/route";

async function multipartReq(url: string, parts: Array<{ name: string; value: string | Blob; filename?: string }>) {
  const fd = new FormData();
  for (const p of parts) {
    if (typeof p.value === "string") fd.append(p.name, p.value);
    else fd.append(p.name, p.value, p.filename);
  }
  return new NextRequest(url, {
    method: "POST",
    headers: { authorization: "Bearer x" },
    body: fd as unknown as BodyInit,
  });
}

describe("HR Documents E2E — smart router", () => {
  beforeEach(() => {
    hrDocs.clear();
    benefitDocs.clear();
    benefitPlans.length = 0;
    benefitRecs.length = 0;
  });

  it("upload W-4 → categorized as w4 → stored in instinct_hr_documents → no benefits side-effects", async () => {
    const req = await multipartReq("http://t/api/people/documents", [
      { name: "file", value: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }), filename: "alicia-w4.pdf" },
    ]);
    const res = await docsPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.category).toBe("w4");
    expect(data.confidence).toBeGreaterThan(0);
    expect(data.benefitDocumentId).toBeUndefined();
    expect(hrDocs.size).toBe(1);
    expect(benefitDocs.size).toBe(0);
  });

  it("upload benefits renewal → categorized as benefits_renewal → BOTH instinct_hr_documents AND apex_benefit_* populated", async () => {
    const req = await multipartReq("http://t/api/people/documents", [
      { name: "file", value: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }), filename: "bcbs-renewal.pdf" },
    ]);
    const res = await docsPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.category).toBe("benefits_renewal");
    expect(data.benefitDocumentId).toBeDefined();
    expect(data.benefitPlanCount).toBeGreaterThan(0);
    expect(hrDocs.size).toBe(1);
    expect(benefitDocs.size).toBe(1);
    expect(benefitPlans.length).toBeGreaterThan(0);
  });

  it("upload random PDF → unclassified → stored, no side-effects", async () => {
    const req = await multipartReq("http://t/api/people/documents", [
      { name: "file", value: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }), filename: "mystery.pdf" },
    ]);
    const res = await docsPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.category).toBe("unclassified");
    expect(hrDocs.size).toBe(1);
    expect(benefitDocs.size).toBe(0);
  });

  it("upload from benefits_tab source still routes correctly (W-4 lands in Documents, not Benefits)", async () => {
    const req = await multipartReq("http://t/api/people/documents", [
      { name: "file", value: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }), filename: "w4.pdf" },
      { name: "source", value: "benefits_tab" },
    ]);
    const res = await docsPOST(req);
    const data = await res.json();
    expect(data.category).toBe("w4");
    expect(data.benefitDocumentId).toBeUndefined();
  });

  it("GET /api/people/documents lists every uploaded doc", async () => {
    await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "w4.pdf" }]));
    await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "i9.pdf" }]));
    const list = await docsGET(new NextRequest("http://t/api/people/documents", { headers: { authorization: "Bearer x" } }));
    const data = await list.json();
    expect(data.documents.length).toBe(2);
  });

  it("GET ?category=w4 filters", async () => {
    await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "w4.pdf" }]));
    await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "i9.pdf" }]));
    const list = await docsGET(new NextRequest("http://t/api/people/documents?category=w4", { headers: { authorization: "Bearer x" } }));
    const data = await list.json();
    expect(data.documents.length).toBe(1);
    expect(data.documents[0].category).toBe("w4");
  });

  it("PATCH recategorize moves a doc from w4 → i9", async () => {
    const upload = await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "w4.pdf" }]));
    const { documentId } = await upload.json();
    const patchReq = new NextRequest(`http://t/api/people/documents/${documentId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ category: "i9" }),
    });
    const patchRes = await docDetailPATCH(patchReq, { params: Promise.resolve({ id: documentId }) });
    expect(patchRes.status).toBe(200);
    expect(hrDocs.get(documentId)?.category).toBe("i9");
  });

  it("PATCH rejects invalid category with 400", async () => {
    const upload = await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "w4.pdf" }]));
    const { documentId } = await upload.json();
    const patchReq = new NextRequest(`http://t/api/people/documents/${documentId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ category: "frobnicator" }),
    });
    const patchRes = await docDetailPATCH(patchReq, { params: Promise.resolve({ id: documentId }) });
    expect(patchRes.status).toBe(400);
  });

  it("DELETE removes the doc", async () => {
    const upload = await docsPOST(await multipartReq("http://t/api/people/documents", [{ name: "file", value: new Blob([new Uint8Array([1])], { type: "application/pdf" }), filename: "w4.pdf" }]));
    const { documentId } = await upload.json();
    const delReq = new NextRequest(`http://t/api/people/documents/${documentId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer x" },
    });
    const delRes = await docDetailDELETE(delReq, { params: Promise.resolve({ id: documentId }) });
    expect(delRes.status).toBe(200);
    expect(hrDocs.has(documentId)).toBe(false);
  });

  it("GET /api/people/documents/[id] returns 404 for missing doc", async () => {
    const req = new NextRequest("http://t/api/people/documents/missing", { headers: { authorization: "Bearer x" } });
    const res = await docDetailGET(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});

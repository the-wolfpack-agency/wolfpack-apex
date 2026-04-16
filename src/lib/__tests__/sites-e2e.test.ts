/**
 * Sites end-to-end integration test.
 *
 * Walks the full Max + Meghan flow against the real route handlers, with
 * a STATEFUL in-memory DB mock and stubbed GitHub client. This catches
 * flow bugs that per-call mocks miss (e.g. "the dropzone validates a
 * slug that doesn't exist yet", "PATCH after POST returns the wrong
 * shape", "webhook update doesn't reflect in subsequent GETs").
 *
 * Flow exercised:
 *   1. POST /api/sites/parse-brief (multipart)        — drop a brief
 *   2. POST /api/sites                                 — create from parsed
 *   3. GET  /api/sites/[id]                            — verify shape
 *   4. PATCH /api/sites/[id]                           — update brief
 *   5. PATCH /api/sites/[id]?action=deploy             — kick off deploy
 *   6. POST /api/sites/webhook                         — webhook callback
 *   7. GET  /api/sites/[id]                            — verify status=ready
 *   8. POST /api/sites/[id]/assets                     — upload an image
 *
 * Each step asserts the wire shape matches what the UI expects, so a
 * field rename or missing key fails the test instead of the user.
 */

/* ---------- stateful in-memory DB ---------- */

interface Row {
  id: string;
  client_slug: string;
  display_name: string;
  brief: unknown;
  status: string;
  created_by: string;
  github_repo: string | null;
  github_repo_url: string | null;
  preview_url: string | null;
  last_deploy_id: string | null;
  last_canary_passed: boolean | null;
  agentic_findings: unknown[];
  created_at: string;
  updated_at: string;
}

const projects = new Map<string, Row>();
const deploys = new Map<string, { id: string; project_id: string; triggered_by: string; status: string; preview_url: string | null; canary_passed: boolean | null }>();
const assets: Array<Record<string, unknown>> = [];

function fakeDb(sql: string, params: unknown[] = []) {
  const s = sql.replace(/\s+/g, " ").trim();
  // INSERT INTO apex_site_projects
  if (s.startsWith("INSERT INTO apex_site_projects")) {
    const [id, client_slug, display_name, brief, , created_by] = params as [string, string, string, string, string, string];
    const row: Row = {
      id,
      client_slug,
      display_name,
      brief: JSON.parse(brief),
      status: "draft",
      created_by,
      github_repo: null,
      github_repo_url: null,
      preview_url: null,
      last_deploy_id: null,
      last_canary_passed: null,
      agentic_findings: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    projects.set(id, row);
    return { rows: [row] };
  }
  if (s.startsWith("SELECT * FROM apex_site_projects WHERE id =")) {
    const row = projects.get(params[0] as string);
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith("SELECT * FROM apex_site_projects ORDER BY") ||
      s.startsWith("SELECT * FROM apex_site_projects WHERE status != 'archived' ORDER BY")) {
    const rows = [...projects.values()].filter((r) => r.status !== "archived");
    return { rows: rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at)) };
  }
  if (s.startsWith("UPDATE apex_site_projects SET brief =")) {
    const [id, brief, display_name] = params as [string, string, string];
    const row = projects.get(id);
    if (!row) return { rows: [] };
    row.brief = JSON.parse(brief);
    row.display_name = display_name;
    row.updated_at = new Date().toISOString();
    return { rows: [row] };
  }
  if (s.startsWith("UPDATE apex_site_projects SET github_repo =")) {
    const [id, github_repo, github_repo_url] = params as [string, string, string];
    const row = projects.get(id);
    if (!row) return { rows: [] };
    row.github_repo = github_repo;
    row.github_repo_url = github_repo_url;
    row.status = "provisioning";
    return { rows: [row] };
  }
  // Two phases of project status update during a deploy:
  //   a) "SET status = 'deploying', last_deploy_id = $2" (literal status)
  //   b) "SET status = $2, preview_url = ..." (post-webhook)
  if (s.includes("SET status = 'deploying'")) {
    const [id, deploy_id] = params as [string, string];
    const row = projects.get(id);
    if (!row) return { rows: [] };
    row.status = "deploying";
    row.last_deploy_id = deploy_id;
    return { rows: [row] };
  }
  if (s.includes("UPDATE apex_site_projects SET status = 'failed'")) {
    const [id] = params as [string];
    const row = projects.get(id);
    if (row) row.status = "failed";
    return { rows: row ? [row] : [] };
  }
  if (s.startsWith("UPDATE apex_site_projects SET status = $2, preview_url")) {
    const [id, status, preview_url, canary_passed] = params as [string, string, string | null, boolean | null];
    const row = projects.get(id);
    if (!row) return { rows: [] };
    row.status = status;
    if (preview_url) row.preview_url = preview_url;
    row.last_canary_passed = canary_passed;
    return { rows: [row] };
  }
  // INSERT INTO apex_site_deploys
  if (s.startsWith("INSERT INTO apex_site_deploys")) {
    const [id, project_id, triggered_by] = params as [string, string, string];
    deploys.set(id, { id, project_id, triggered_by, status: "pending", preview_url: null, canary_passed: null });
    return { rows: [] };
  }
  if (s.startsWith("UPDATE apex_site_deploys SET workflow_run")) {
    return { rows: [] };
  }
  if (s.startsWith("UPDATE apex_site_deploys SET status = $2, preview_url")) {
    const [id, status, preview_url, canary_passed] = params as [string, string, string | null, boolean | null];
    const d = deploys.get(id);
    if (!d) return { rows: [] };
    d.status = status;
    d.preview_url = preview_url;
    d.canary_passed = canary_passed;
    return { rows: [d] };
  }
  if (s.startsWith("INSERT INTO apex_site_assets")) {
    const [id, project_id, filename, mime_type, size_bytes, storage_url, uploaded_by] = params as string[];
    assets.push({ id, project_id, filename, mime_type, size_bytes, storage_url, uploaded_by });
    return { rows: [] };
  }
  return { rows: [] };
}

jest.mock("@/lib/db", () => ({
  query: (sql: string, params?: unknown[]) => Promise.resolve(fakeDb(sql, params)),
  safeQuery: (sql: string, params?: unknown[]) => Promise.resolve(fakeDb(sql, params)),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => ({ id: "user_test", role: "sales", name: "Test User", email: "t@test" }),
}));

jest.mock("@/lib/github-client", () => ({
  createRepoFromTemplate: jest.fn(async (_c, _to, _t, owner, name) => ({
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
  })),
  putFile: jest.fn(async () => undefined),
  triggerWorkflow: jest.fn(async () => ({ run_id: "run_e2e_1" })),
  defaultGithubClient: () => ({ token: "test", fetch: jest.fn() }),
}));

import { NextRequest } from "next/server";
import { POST as parsePOST } from "@/app/api/sites/parse-brief/route";
import { POST as createPOST, GET as listGET } from "@/app/api/sites/route";
import { GET as detailGET, PATCH as detailPATCH } from "@/app/api/sites/[id]/route";
import { POST as webhookPOST } from "@/app/api/sites/webhook/route";
import { POST as assetsPOST } from "@/app/api/sites/[id]/assets/route";

const RICH_HTML = `
<html><body>
  <h1>Acme Industries</h1>
  <h2>The leading widget company</h2>
  <p>Acme has been making widgets for 50 years. Our flagship product, the Anvil, ships to 60 countries and supports 145M+ users worldwide.</p>
  <div>145M+ Active Users</div>
  <div>280K Daily Orders</div>
  <div>60+ Countries Served</div>
  <div>93M+ Widgets Shipped</div>
  <img src="/img/factory.jpg" alt="Factory" />
  <img src="/img/anvil.jpg" alt="Anvil" />
  <img src="/img/team.jpg" alt="Team" />
</body></html>
`;

function jsonReq(url: string, method: string, body: unknown): NextRequest {
  const init: RequestInit = {
    method,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
  };
  if (body !== null && method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(body);
  }
  return new NextRequest(url, init);
}

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

describe("Sites E2E — full Max + Meghan flow", () => {
  beforeAll(() => {
    process.env.WOLFPACK_SITES_WEBHOOK_SECRET = "shh-e2e";
  });
  afterAll(() => {
    delete process.env.WOLFPACK_SITES_WEBHOOK_SECRET;
  });
  beforeEach(() => {
    projects.clear();
    deploys.clear();
    assets.length = 0;
  });

  it("walks the entire create → deploy → webhook → ready lifecycle", async () => {
    // 1. Parse a dropped brief
    const parseReq = await multipartReq("http://t/api/sites/parse-brief", [
      { name: "file", value: new Blob([RICH_HTML], { type: "text/html" }), filename: "brief.html" },
      { name: "clientSlug", value: "acme" },
    ]);
    const parseRes = await parsePOST(parseReq);
    expect(parseRes.status).toBe(200);
    const parsed = await parseRes.json();
    expect(parsed.brief).toBeDefined();
    expect(parsed.brief.client).toBe("acme");
    expect(parsed.brief.product.name).toBe("Acme Industries");
    // The heuristic should have found stats and images:
    const sectionTypes = parsed.brief.pages[0].sections.map((s: { type: string }) => s.type);
    expect(sectionTypes).toContain("hero");
    expect(sectionTypes).toContain("stats");
    expect(sectionTypes).toContain("gallery");

    // 2. Create the project from the parsed brief
    const createReq = jsonReq("http://t/api/sites", "POST", { brief: parsed.brief });
    const createRes = await createPOST(createReq);
    expect(createRes.status).toBe(201);
    const { project } = await createRes.json();
    expect(project.id).toMatch(/^site_/);
    expect(project.client_slug).toBe("acme");
    expect(project.status).toBe("draft");
    const projectId = project.id;

    // 3. List shows the new project
    const listRes = await listGET(jsonReq("http://t/api/sites", "GET", null));
    expect(listRes.status).toBe(200);
    const { projects: list } = await listRes.json();
    expect(list.find((p: { id: string }) => p.id === projectId)).toBeDefined();

    // 4. Detail GET returns the same shape the UI uses
    const detailRes = await detailGET(jsonReq(`http://t/api/sites/${projectId}`, "GET", null), {
      params: Promise.resolve({ id: projectId }),
    });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.project.brief.client).toBe("acme");
    expect(detail.project.brief.product.name).toBe("Acme Industries");

    // 5. Update the brief (rename the product)
    const updatedBrief = { ...parsed.brief, product: { ...parsed.brief.product, name: "Acme Corp" } };
    const updateRes = await detailPATCH(
      jsonReq(`http://t/api/sites/${projectId}`, "PATCH", { brief: updatedBrief }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.project.display_name).toBe("Acme Corp");

    // 6. Trigger a deploy
    const deployReq = new NextRequest(`http://t/api/sites/${projectId}?action=deploy`, {
      method: "PATCH",
      headers: { authorization: "Bearer x" },
    });
    const deployRes = await detailPATCH(deployReq, { params: Promise.resolve({ id: projectId }) });
    expect(deployRes.status).toBe(200);
    const deploy = await deployRes.json();
    expect(deploy.deployId).toMatch(/^deploy_/);
    const deployId = deploy.deployId;

    // 7. After deploy trigger the project should be in 'deploying' state
    const afterDeployRes = await detailGET(jsonReq(`http://t/api/sites/${projectId}`, "GET", null), {
      params: Promise.resolve({ id: projectId }),
    });
    const afterDeploy = await afterDeployRes.json();
    expect(afterDeploy.project.status).toBe("deploying");
    expect(afterDeploy.project.github_repo).toBe("the-wolfpack-agency/wolfpack-acme");

    // 8. Webhook reports success
    const webhookReq = new NextRequest("http://t/api/sites/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wolfpack-webhook-secret": "shh-e2e",
      },
      body: JSON.stringify({
        deployId,
        status: "success",
        previewUrl: "https://wolfpack-acme.vercel.app",
        canaryPassed: true,
      }),
    });
    const webhookRes = await webhookPOST(webhookReq);
    expect(webhookRes.status).toBe(200);

    // 9. After webhook, project status flips to 'ready' and preview URL is set
    const finalRes = await detailGET(jsonReq(`http://t/api/sites/${projectId}`, "GET", null), {
      params: Promise.resolve({ id: projectId }),
    });
    const final = await finalRes.json();
    expect(final.project.status).toBe("ready");
    expect(final.project.preview_url).toBe("https://wolfpack-acme.vercel.app");
    expect(final.project.last_canary_passed).toBe(true);

    // 10. Upload an asset to the now-provisioned project
    const assetReq = await multipartReq(`http://t/api/sites/${projectId}/assets`, [
      {
        name: "file",
        value: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
        filename: "hero.png",
      },
    ]);
    const assetRes = await assetsPOST(assetReq, { params: Promise.resolve({ id: projectId }) });
    expect(assetRes.status).toBe(200);
    const assetData = await assetRes.json();
    expect(assetData.asset.url).toBe("/acme/hero.png");
    expect(assetData.asset.committed).toBe(true);
    expect(assets).toHaveLength(1);
    expect((assets[0] as { project_id: string }).project_id).toBe(projectId);
  });

  it("dropzone with bad slug returns 400 with a clear message (the bug user hit)", async () => {
    const req = await multipartReq("http://t/api/sites/parse-brief", [
      { name: "file", value: new Blob([RICH_HTML], { type: "text/html" }), filename: "brief.html" },
      { name: "clientSlug", value: "/test" },
    ]);
    const res = await parsePOST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/lowercase slug/);
  });

  it("webhook with wrong secret never mutates state", async () => {
    // Seed a project in deploying state
    const createRes = await createPOST(
      jsonReq("http://t/api/sites", "POST", {
        brief: { client: "test", product: { name: "Test" }, pages: [{ route: "/", sections: [] }] },
      }),
    );
    const { project } = await createRes.json();
    const before = project.status;

    const req = new NextRequest("http://t/api/sites/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wolfpack-webhook-secret": "WRONG" },
      body: JSON.stringify({ deployId: "deploy_x", status: "success" }),
    });
    expect((await webhookPOST(req)).status).toBe(403);

    // Verify the project state didn't change
    const after = await detailGET(jsonReq(`http://t/api/sites/${project.id}`, "GET", null), {
      params: Promise.resolve({ id: project.id }),
    });
    const afterData = await after.json();
    expect(afterData.project.status).toBe(before);
  });
});

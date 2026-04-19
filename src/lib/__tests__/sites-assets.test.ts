/**
 * /api/sites/[id]/assets and /api/sites/parse-brief route tests.
 *
 * Asserts: auth gate, type/size validation, repo commit on provisioned
 * projects, analytics emission, and the parse-brief multipart path.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockGetProject = jest.fn();
const mockRecordAsset = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...args: unknown[]) => mockGetProject(...args),
  recordAssetUpload: (...args: unknown[]) => mockRecordAsset(...args),
}));

const mockPutFile = jest.fn();
jest.mock("@/lib/github-client", () => ({
  putFile: (...args: unknown[]) => mockPutFile(...args),
  defaultGithubClient: () => ({ token: "test", fetch: jest.fn() }),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockParseBrief = jest.fn();
jest.mock("@/lib/brief-parser", () => ({
  parseBrief: (...args: unknown[]) => mockParseBrief(...args),
}));

import { NextRequest } from "next/server";
import { POST as assetsPOST } from "@/app/api/sites/[id]/assets/route";
import { POST as parsePOST } from "@/app/api/sites/parse-brief/route";

function pngBytes(): Uint8Array {
  // Minimal valid 1x1 PNG header bytes (truncated for test purposes)
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}

async function multipartReq(url: string, parts: { name: string; value: string | Blob; filename?: string }[]): Promise<NextRequest> {
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

describe("/api/sites/[id]/assets", () => {
  beforeEach(() => jest.clearAllMocks());

  const PROJECT = {
    id: "site_1",
    client_slug: "cftr",
    github_repo: "the-wolfpack-agency/wolfpack-cftr",
  };

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const req = await multipartReq("http://t/x", [
      { name: "file", value: new Blob([pngBytes() as BlobPart], { type: "image/png" }), filename: "a.png" },
    ]);
    const res = await assetsPOST(req, { params: Promise.resolve({ id: "site_1" }) });
    expect(res.status).toBe(401);
  });

  it("404 when project missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockGetProject.mockResolvedValueOnce(null);
    const req = await multipartReq("http://t/x", [
      { name: "file", value: new Blob([pngBytes() as BlobPart], { type: "image/png" }), filename: "a.png" },
    ]);
    const res = await assetsPOST(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("415 on disallowed mime type", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROJECT);
    const req = await multipartReq("http://t/x", [
      { name: "file", value: new Blob(["evil"], { type: "application/x-msdownload" }), filename: "a.exe" },
    ]);
    const res = await assetsPOST(req, { params: Promise.resolve({ id: "site_1" }) });
    expect(res.status).toBe(415);
  });

  it("happy path: commits to repo, records asset, tracks event", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);
    const req = await multipartReq("http://t/x", [
      { name: "file", value: new Blob([pngBytes() as BlobPart], { type: "image/png" }), filename: "Hero Photo!.png" },
    ]);
    const res = await assetsPOST(req, { params: Promise.resolve({ id: "site_1" }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    // Filename was sanitized
    expect(data.asset.filename).toBe("Hero_Photo_.png");
    expect(data.asset.url).toBe("/cftr/Hero_Photo_.png");
    expect(data.asset.committed).toBe(true);
    expect(mockPutFile).toHaveBeenCalled();
    expect(mockRecordAsset).toHaveBeenCalled();
  });

  it("still records asset even if github commit fails", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROJECT);
    mockPutFile.mockRejectedValueOnce(new Error("422"));
    mockRecordAsset.mockResolvedValueOnce(undefined);
    // Silence the console.error in the route
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const req = await multipartReq("http://t/x", [
      { name: "file", value: new Blob([pngBytes() as BlobPart], { type: "image/png" }), filename: "a.png" },
    ]);
    const res = await assetsPOST(req, { params: Promise.resolve({ id: "site_1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.asset.committed).toBe(false);
    expect(mockRecordAsset).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("/api/sites/parse-brief", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const req = new NextRequest("http://t/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawInput: "x", clientSlug: "test" }),
    });
    expect((await parsePOST(req)).status).toBe(401);
  });

  it("400 on bad slug", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    const req = new NextRequest("http://t/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawInput: "x", clientSlug: "BAD" }),
    });
    expect((await parsePOST(req)).status).toBe(400);
  });

  it("returns parse result on JSON happy path", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockParseBrief.mockResolvedValueOnce({
      brief: { client: "x", product: { name: "X" }, pages: [] },
      source: "heuristic",
      tokensUsed: 0,
      confidence: "high",
    });
    const req = new NextRequest("http://t/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawInput: "<h1>X</h1>", clientSlug: "test" }),
    });
    const res = await parsePOST(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.source).toBe("heuristic");
  });

  it("multipart path tracks site.dropzone_used and forwards to parser", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockParseBrief.mockResolvedValueOnce({
      brief: { client: "cftr", product: { name: "CFTR" }, pages: [] },
      source: "heuristic",
      tokensUsed: 0,
      confidence: "high",
    });
    const req = await multipartReq("http://t/parse", [
      { name: "file", value: new Blob(["<h1>CFTR</h1>"], { type: "text/html" }), filename: "brief.html" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await parsePOST(req);
    expect(res.status).toBe(200);
    const events = mockTrack.mock.calls.map((c) => c[0]);
    expect(events).toContain("site.dropzone_used");
    expect(mockParseBrief).toHaveBeenCalled();
  });

  it("422 when parser throws", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockParseBrief.mockRejectedValueOnce(new Error("nothing to parse"));
    const req = new NextRequest("http://t/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawInput: "x", clientSlug: "test" }),
    });
    expect((await parsePOST(req)).status).toBe(422);
  });
});

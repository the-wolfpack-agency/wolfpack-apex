/**
 * /api/sites/[id]/assets — full flow test suite.
 *
 * Created 2026-04-17 to close the gap left by commit c6368a8, which
 * fixed putFile's double-base64 corruption but only added a unit test
 * round-trip at the github-client layer. This file owns the ROUTE
 * handler: every branch, every error path, every mock call shape.
 *
 * Test title prefix: "sites assets —".
 *
 * Do not touch the route, sites.ts, or github-client.ts in the same
 * commit — if a real bug is surfaced here (e.g. missing success
 * analytics event), write a labeled failing test that documents it
 * and let it fail loudly in CI.
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
const mockDefaultClient: jest.Mock = jest.fn(() => ({ token: "gh_test_token", fetch: jest.fn() }));
jest.mock("@/lib/github-client", () => ({
  putFile: (...args: any[]) => mockPutFile(...args),
  defaultGithubClient: (...args: any[]) => mockDefaultClient(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/sites/[id]/assets/route";

// ---------- helpers ----------

const PROVISIONED_PROJECT = {
  id: "site_flow_1",
  client_slug: "cftr",
  github_repo: "the-wolfpack-agency/wolfpack-cftr",
};

const UNPROVISIONED_PROJECT = {
  id: "site_flow_2",
  client_slug: "draft-client",
  github_repo: null,
};

function bytes(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  // Deterministic byte pattern so we can verify the Buffer passed into
  // putFile is the same bytes we uploaded (binary round-trip).
  for (let i = 0; i < size; i++) arr[i] = (i * 31 + 7) & 0xff;
  return arr;
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}

/**
 * Build a multipart request the route can consume. Uses the platform
 * File constructor (available in Node 20+, which this repo runs on).
 * Falls back to Blob+filename if File is unavailable — either is
 * accepted by undici's FormData -> Request pipeline that NextRequest
 * delegates to.
 */
function makeReq(
  url: string,
  parts: { name: string; value: string | Uint8Array; filename?: string; type?: string }[],
  opts: { auth?: string } = { auth: "Bearer t" },
): NextRequest {
  const fd = new FormData();
  for (const p of parts) {
    if (typeof p.value === "string") {
      fd.append(p.name, p.value);
      continue;
    }
     
    const FileCtor: any = (globalThis as any).File;
    if (typeof FileCtor === "function") {
      const file = new FileCtor([p.value], p.filename ?? "unnamed.bin", {
        type: p.type ?? "application/octet-stream",
      });
      fd.append(p.name, file);
    } else {
      const blob = new Blob([p.value as BlobPart], { type: p.type ?? "application/octet-stream" });
      fd.append(p.name, blob, p.filename ?? "unnamed.bin");
    }
  }
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: fd as unknown as BodyInit,
  });
}

async function postAssets(req: NextRequest, id: string) {
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDefaultClient.mockReturnValue({ token: "gh_test_token", fetch: jest.fn() });
});

// ---------- 1. Auth gate + project lookup ----------

describe("sites assets — auth + project lookup", () => {
  test("401 when no auth header", async () => {
    mockGetUser.mockReturnValue(null);
    const req = makeReq(
      "http://t/api/sites/site_flow_1/assets",
      [{ name: "file", value: pngBytes(), filename: "a.png", type: "image/png" }],
      { auth: undefined },
    );
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(mockGetProject).not.toHaveBeenCalled();
    expect(mockRecordAsset).not.toHaveBeenCalled();
  });

  test("404 when project missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_missing", role: "sales" });
    mockGetProject.mockResolvedValueOnce(null);
    const req = makeReq("http://t/api/sites/nope/assets", [
      { name: "file", value: pngBytes(), filename: "a.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("project not found");
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockRecordAsset).not.toHaveBeenCalled();
  });
});

// ---------- 2. Rate limit (20/user/hour) ----------

describe("sites assets — rate limit", () => {
  test("21st request from same user returns 429 with Retry-After header", async () => {
    // Unique user id — the route uses a module-level Map, so we must
    // isolate from other tests in this file.
    const uid = `u_rl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    mockGetUser.mockReturnValue({ id: uid, role: "sales" });
    mockGetProject.mockResolvedValue(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValue(undefined);
    mockRecordAsset.mockResolvedValue(undefined);

    // 20 successful uploads
    for (let i = 0; i < 20; i++) {
      const req = makeReq("http://t/api/sites/site_flow_1/assets", [
        { name: "file", value: pngBytes(), filename: `n${i}.png`, type: "image/png" },
      ]);
      const res = await postAssets(req, "site_flow_1");
      expect(res.status).toBe(200);
    }

    // 21st — should be rate-limited
    const over = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: "over.png", type: "image/png" },
    ]);
    const res = await postAssets(over, "site_flow_1");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    const retrySeconds = Number(res.headers.get("Retry-After"));
    expect(retrySeconds).toBeGreaterThan(0);
    expect(retrySeconds).toBeLessThanOrEqual(60 * 60);
    const body = await res.json();
    expect(body.error).toMatch(/too many uploads/i);

    // Verify the rate-limit analytics event fired for the 21st attempt
    const rlEvents = mockTrack.mock.calls.filter(
      (c) => c[0] === "system.upload_rate_limited",
    );
    expect(rlEvents.length).toBeGreaterThanOrEqual(1);
    expect(rlEvents[0][1]).toBe(uid);
    expect(rlEvents[0][3]).toEqual(
      expect.objectContaining({ endpoint: "sites/assets" }),
    );
  });

  test("window reset — fake timers advance past UPLOAD_WINDOW_MS and next request succeeds", async () => {
    const uid = `u_rlreset_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    mockGetUser.mockReturnValue({ id: uid, role: "sales" });
    mockGetProject.mockResolvedValue(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValue(undefined);
    mockRecordAsset.mockResolvedValue(undefined);

    // Burn through 20 uploads
    for (let i = 0; i < 20; i++) {
      const req = makeReq("http://t/api/sites/site_flow_1/assets", [
        { name: "file", value: pngBytes(), filename: `n${i}.png`, type: "image/png" },
      ]);
      const res = await postAssets(req, "site_flow_1");
      expect(res.status).toBe(200);
    }

    // 21st fails
    const blocked = await postAssets(
      makeReq("http://t/api/sites/site_flow_1/assets", [
        { name: "file", value: pngBytes(), filename: "blocked.png", type: "image/png" },
      ]),
      "site_flow_1",
    );
    expect(blocked.status).toBe(429);

    // Advance clock past the 1-hour window and verify the next request clears.
    // Route uses Date.now() directly — jest fake timers cover it.
    const realNow = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(realNow + 61 * 60 * 1000);
    try {
      const after = await postAssets(
        makeReq("http://t/api/sites/site_flow_1/assets", [
          { name: "file", value: pngBytes(), filename: "after.png", type: "image/png" },
        ]),
        "site_flow_1",
      );
      expect(after.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------- 3. File type validation ----------

describe("sites assets — file type validation", () => {
  test("415 on application/pdf with allowed-list in error body", async () => {
    mockGetUser.mockReturnValue({ id: "u_type_pdf", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: "brief.pdf", type: "application/pdf" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toContain("application/pdf");
    expect(body.error).toContain("image/jpeg");
    expect(body.error).toContain("image/png");
    expect(body.error).toContain("image/webp");
    expect(body.error).toContain("image/gif");
    expect(body.error).toContain("image/svg+xml");
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockRecordAsset).not.toHaveBeenCalled();
  });

  test("415 on empty content-type string", async () => {
    mockGetUser.mockReturnValue({ id: "u_type_empty", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: "mystery.bin", type: "" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(415);
    expect(mockRecordAsset).not.toHaveBeenCalled();
  });

  test.each([
    ["image/jpeg", "a.jpg"],
    ["image/png", "a.png"],
    ["image/webp", "a.webp"],
    ["image/gif", "a.gif"],
    ["image/svg+xml", "a.svg"],
  ])("allows %s", async (mime, name) => {
    mockGetUser.mockReturnValue({ id: `u_type_ok_${mime}`, role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: name, type: mime },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.mimeType).toBe(mime);
  });
});

// ---------- 4. Size cap (8 MB) ----------

describe("sites assets — size cap", () => {
  test("413 on payload > 8 MB", async () => {
    mockGetUser.mockReturnValue({ id: "u_size", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    const huge = bytes(8 * 1024 * 1024 + 1);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: huge, filename: "huge.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
    expect(body.error).toContain(String(8 * 1024 * 1024));
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockRecordAsset).not.toHaveBeenCalled();
  });

  test("accepts exactly 8 MB", async () => {
    mockGetUser.mockReturnValue({ id: "u_size_edge", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);
    const exact = bytes(8 * 1024 * 1024);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: exact, filename: "exact.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);
  });
});

// ---------- 5. Multipart body validation ----------

describe("sites assets — multipart body validation", () => {
  test("400 when no 'file' field present", async () => {
    mockGetUser.mockReturnValue({ id: "u_mp1", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "altText", value: "just alt, no file" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("file required");
  });

  test("400 on malformed multipart body (invalid content-type, garbage body)", async () => {
    mockGetUser.mockReturnValue({ id: "u_mp2", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    const req = new NextRequest("http://t/api/sites/site_flow_1/assets", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "multipart/form-data; boundary=----notarealboundary",
      },
      body: "this is not a valid multipart body at all",
    });
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(400);
    const body = await res.json();
    // Could fall through either the "file required" branch or the
    // try/catch "invalid multipart body" branch depending on how
    // undici parses the garbage. Both are acceptable 400 outcomes.
    expect(body.error).toMatch(/file required|invalid multipart body/);
    expect(mockRecordAsset).not.toHaveBeenCalled();
  });

  test("400 when 'file' field is a plain string, not a File", async () => {
    mockGetUser.mockReturnValue({ id: "u_mp3", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    // Text-valued "file" field — should fail the instanceof File check.
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: "not-a-file-just-a-string" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("file required");
  });
});

// ---------- 6. Filename sanitization / path traversal defense ----------

describe("sites assets — filename sanitization", () => {
  test("traversal attempt '../../etc/passwd.jpg' is reduced to a safe single segment", async () => {
    mockGetUser.mockReturnValue({ id: "u_safe1", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      {
        name: "file",
        value: pngBytes(),
        filename: "../../etc/passwd.jpg",
        type: "image/jpeg",
      },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);
    const body = await res.json();

    // The safe filename MUST NOT contain a forward slash — otherwise
    // the commit path would have extra directory depth.
    expect(body.asset.filename).not.toContain("/");
    expect(body.asset.filename).not.toContain("\\");
    // Matches the route regex: [^a-zA-Z0-9._-] -> "_"
    // "../../etc/passwd.jpg" -> ".._.._etc_passwd.jpg"
    expect(body.asset.filename).toBe(".._.._etc_passwd.jpg");

    // The committed repo path must live strictly under the client's
    // public/{slug}/ dir — exactly two path segments after the slug.
    expect(mockPutFile).toHaveBeenCalled();
    const repoPath = mockPutFile.mock.calls[0][2] as string;
    expect(repoPath).toBe("public/cftr/.._.._etc_passwd.jpg");
    expect(repoPath.startsWith("public/cftr/")).toBe(true);
    // no stray "/" after the slug segment
    const afterSlug = repoPath.slice("public/cftr/".length);
    expect(afterSlug).not.toContain("/");
  });

  test("filename > 100 chars is truncated to 100", async () => {
    mockGetUser.mockReturnValue({ id: "u_safe2", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const longName = "a".repeat(200) + ".png";
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: longName, type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.filename.length).toBe(100);
  });

  test("unicode and spaces in filename are scrubbed", async () => {
    mockGetUser.mockReturnValue({ id: "u_safe3", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: "hero photo 🔥.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

// ---------- 7. Commit to repo when github_repo is set ----------

describe("sites assets — commit to provisioned repo", () => {
  test("putFile is called with a Buffer (not a base64 string) — binary integrity", async () => {
    mockGetUser.mockReturnValue({ id: "u_commit1", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const original = bytes(256);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: original, filename: "hero.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);

    expect(mockPutFile).toHaveBeenCalledTimes(1);
    const [client, repo, path, content, message] = mockPutFile.mock.calls[0];

    // Client came from defaultGithubClient()
    expect(mockDefaultClient).toHaveBeenCalled();
    expect(client).toEqual(expect.objectContaining({ token: "gh_test_token" }));

    expect(repo).toBe("the-wolfpack-agency/wolfpack-cftr");
    expect(path).toBe("public/cftr/hero.png");

    // THE CORE REGRESSION GUARD: the route must pass a Buffer, not a
    // base64-encoded string. This is the exact shape that the
    // 2026-04-18 incident corrupted. If someone re-introduces
    // buffer.toString("base64") before this call, this test fails.
    expect(Buffer.isBuffer(content)).toBe(true);
    expect((content as Buffer).length).toBe(original.length);
    expect(Buffer.from(original).equals(content as Buffer)).toBe(true);

    expect(message).toContain("hero.png");
    expect(message).toContain("cftr");

    // Response surfaces the user-visible storage URL
    const body = await res.json();
    expect(body.asset.url).toBe("/cftr/hero.png");
    expect(body.asset.committed).toBe(true);
    expect(body.asset.sizeBytes).toBe(original.length);
  });
});

// ---------- 8. Graceful degrade — github_repo is null ----------

describe("sites assets — unprovisioned project (github_repo null)", () => {
  test("records the row, skips putFile, returns committed:false, no throw", async () => {
    mockGetUser.mockReturnValue({ id: "u_unprov", role: "sales" });
    mockGetProject.mockResolvedValueOnce(UNPROVISIONED_PROJECT);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const req = makeReq("http://t/api/sites/site_flow_2/assets", [
      { name: "file", value: pngBytes(), filename: "wip.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.committed).toBe(false);
    // storageUrl still computed and returned
    expect(body.asset.url).toBe("/draft-client/wip.png");

    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockDefaultClient).not.toHaveBeenCalled();
    expect(mockRecordAsset).toHaveBeenCalledTimes(1);
  });
});

// ---------- 9. Graceful degrade — putFile throws ----------

describe("sites assets — github commit failure", () => {
  test("putFile throws 422 -> 200 with committed:false, user still gets storageUrl, error logged", async () => {
    mockGetUser.mockReturnValue({ id: "u_fail", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockRejectedValueOnce(new Error("422 Unprocessable Entity"));
    mockRecordAsset.mockResolvedValueOnce(undefined);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: "will-fail.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.asset.committed).toBe(false);
    expect(body.asset.url).toBe("/cftr/will-fail.png");
    expect(body.asset.filename).toBe("will-fail.png");

    // Row still recorded so the operator sees the upload in the UI.
    expect(mockRecordAsset).toHaveBeenCalledTimes(1);

    // Error was logged, not thrown.
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/github commit failed/i);
    errSpy.mockRestore();
  });
});

// ---------- 10. recordAssetUpload arg shape ----------

describe("sites assets — recordAssetUpload wiring", () => {
  test("called with (projectId, safeName, mimeType, sizeBytes, storageUrl, userId, userRole)", async () => {
    mockGetUser.mockReturnValue({ id: "u_record", role: "cto" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const body = bytes(512);
    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: body, filename: "Banner Shot!.JPG", type: "image/jpeg" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);

    expect(mockRecordAsset).toHaveBeenCalledTimes(1);
    const args = mockRecordAsset.mock.calls[0];
    // [projectId, safeName, mimeType, sizeBytes, storageUrl, userId, userRole]
    expect(args[0]).toBe("site_flow_1");
    expect(args[1]).toBe("Banner_Shot_.JPG");
    expect(args[2]).toBe("image/jpeg");
    expect(args[3]).toBe(body.length);
    expect(args[4]).toBe("/cftr/Banner_Shot_.JPG");
    expect(args[5]).toBe("u_record");
    expect(args[6]).toBe("cto");
    expect(args.length).toBe(7);
  });
});

// ---------- 11. Analytics ----------
//
// NOTE — REAL BUG SURFACED (2026-04-17):
//
// The route docstring (lines 1-15 of route.ts) documents step 4 as:
//     "4. trackEvent('site.asset_uploaded')"
// but the implementation never emits that event on the success path.
// The only trackEvent call is `system.upload_rate_limited` on the
// rate-limit branch (line 50). The asset-upload funnel is therefore
// invisible to product analytics — directly violates the project
// memory directive
//     feedback_analytics_tied_to_every_feature.md
// ("every feature must tie into analytics / no orphan features").
//
// We DO NOT fix the route in this commit (test-file-only deliverable).
// The test below is labeled [REAL BUG] and will fail red until the
// route is amended to emit site.asset_uploaded with at minimum
// { project_id, filename, sizeBytes }.

describe("sites assets — analytics", () => {
  test("[REAL BUG] emits site.asset_uploaded on successful commit (project_id + filename + sizeBytes)", async () => {
    mockGetUser.mockReturnValue({ id: "u_analytics", role: "sales" });
    mockGetProject.mockResolvedValueOnce(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValueOnce(undefined);
    mockRecordAsset.mockResolvedValueOnce(undefined);

    const req = makeReq("http://t/api/sites/site_flow_1/assets", [
      { name: "file", value: pngBytes(), filename: "hero.png", type: "image/png" },
    ]);
    const res = await postAssets(req, "site_flow_1");
    expect(res.status).toBe(200);

    const uploadedCalls = mockTrack.mock.calls.filter(
      (c) => c[0] === "site.asset_uploaded",
    );
    // This assertion currently FAILS on main — the route docstring
    // promises this event but the handler never emits it. See comment
    // block above.
    expect(uploadedCalls.length).toBeGreaterThanOrEqual(1);
    if (uploadedCalls.length > 0) {
      const [, userId, userRole, metadata] = uploadedCalls[0];
      expect(userId).toBe("u_analytics");
      expect(userRole).toBe("sales");
      // Snake-case to match the rest of the analytics key convention
      // in this codebase (project_id, client_slug, etc.). Fixed as
      // part of the same commit that added the missing emission.
      expect(metadata).toEqual(
        expect.objectContaining({
          project_id: "site_flow_1",
          filename: "hero.png",
          size_bytes: expect.any(Number),
        }),
      );
    }
  });

  test("emits system.upload_rate_limited when rate-limited (already covered, guarded here)", async () => {
    const uid = `u_rlevt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    mockGetUser.mockReturnValue({ id: uid, role: "sales" });
    mockGetProject.mockResolvedValue(PROVISIONED_PROJECT);
    mockPutFile.mockResolvedValue(undefined);
    mockRecordAsset.mockResolvedValue(undefined);

    for (let i = 0; i < 20; i++) {
      await postAssets(
        makeReq("http://t/api/sites/site_flow_1/assets", [
          { name: "file", value: pngBytes(), filename: `n${i}.png`, type: "image/png" },
        ]),
        "site_flow_1",
      );
    }
    mockTrack.mockClear();
    await postAssets(
      makeReq("http://t/api/sites/site_flow_1/assets", [
        { name: "file", value: pngBytes(), filename: "over.png", type: "image/png" },
      ]),
      "site_flow_1",
    );
    const events = mockTrack.mock.calls.map((c) => c[0]);
    expect(events).toContain("system.upload_rate_limited");
  });
});

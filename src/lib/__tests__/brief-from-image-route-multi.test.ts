/**
 * /api/sites/parse-brief — multi-frame path contract tests.
 *
 * Mirrors parse-brief-image.test.ts but exercises the new `files[]`
 * dispatch added for multi-page wireframe uploads (2026-04-19).
 *
 * Covers:
 *  - Legacy single `file` still works (regression gate)
 *  - Multi-file `files[]` with 3 images → briefFromFrames called with
 *    3 ordered frames → 200 + metadata.frameCount === 3
 *  - 11 files → 400 too_many_frames + analytics fired
 *  - Mixed bad MIME in set → 400 unsupported_mime
 *  - Auth gate still applies (401 with no token)
 *  - Missing clientSlug in multi-frame set → 400
 *  - Single file posted under `files[]` collapses to single-file path
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockParseBrief = jest.fn();
jest.mock("@/lib/brief-parser", () => ({
  parseBrief: (...args: unknown[]) => mockParseBrief(...args),
}));

const mockBriefFromImage = jest.fn();
const mockBriefFromFrames = jest.fn();

// Mirror the real error trio so `instanceof` checks inside the route
// still resolve. Jest hoists jest.mock so classes are defined here.
jest.mock("@/lib/brief-from-image", () => {
  class FakeBriefError extends Error {
    reason: "bad_ai_output" | "brief_invalid" | "unsupported_mime";
    constructor(
      msg: string,
      reason: "bad_ai_output" | "brief_invalid" | "unsupported_mime",
    ) {
      super(msg);
      this.name = "BriefFromImageError";
      this.reason = reason;
    }
  }
  class FakeAIUnavailable extends Error {
    constructor(msg = "unavailable") {
      super(msg);
      this.name = "BriefFromImageAIUnavailableError";
    }
  }
  class FakeNotConfigured extends Error {
    constructor(msg = "ANTHROPIC_API_KEY is not set") {
      super(msg);
      this.name = "BriefFromImageNotConfiguredError";
    }
  }
  return {
    briefFromImage: (...args: unknown[]) => mockBriefFromImage(...args),
    briefFromFrames: (...args: unknown[]) => mockBriefFromFrames(...args),
    SUPPORTED_IMAGE_MIMES: new Set([
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "application/pdf",
    ]),
    BriefFromImageError: FakeBriefError,
    BriefFromImageAIUnavailableError: FakeAIUnavailable,
    BriefFromImageNotConfiguredError: FakeNotConfigured,
  };
});

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/sites/parse-brief/route";

const AUTH = { id: "u_1", role: "sales", name: "User", email: "u@x" };

function makeMultipartReq(
  parts: {
    name: string;
    value: string | Uint8Array;
    filename?: string;
    type?: string;
  }[],
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
       
      const blob = new Blob([p.value as any], {
        type: p.type ?? "application/octet-stream",
      });
      fd.append(p.name, blob, p.filename ?? "unnamed.bin");
    }
  }
  return new NextRequest("http://test/api/sites/parse-brief", {
    method: "POST",
    headers: { authorization: "Bearer t" },
    body: fd as unknown as BodyInit,
  });
}

function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
}

const HAPPY_FRAMES_RESULT = {
  generationId: "site_brief_gen_multi",
  brief: {
    client: "cftr",
    product: { name: "CFTR" },
    pages: [
      { route: "/", sections: [{ type: "hero", heading: "Hi" }] },
      { route: "/about", sections: [{ type: "hero", heading: "About" }] },
    ],
  },
  metrics: {
    latencyMs: 600,
    tokensIn: 1200,
    tokensOut: 800,
    costCents: 5,
    model: "claude-haiku-4-5-20251001",
  },
  extractedColors: ["#123456", "#abcdef"],
  detectedFont: "Inter",
  confidence: "high" as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue(AUTH);
});

describe("parse-brief route — multi-frame path", () => {
  it("legacy single `file` path still works (regression gate)", async () => {
    mockBriefFromImage.mockResolvedValueOnce({
      ...HAPPY_FRAMES_RESULT,
      generationId: "site_brief_gen_single",
    });
    const req = makeMultipartReq([
      { name: "file", value: tinyPng(), filename: "w.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("vision");
    expect(mockBriefFromImage).toHaveBeenCalledTimes(1);
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
  });

  it("happy path: 3 `files[]` images → briefFromFrames with 3 frames → 200 + frameCount:3", async () => {
    mockBriefFromFrames.mockResolvedValueOnce(HAPPY_FRAMES_RESULT);
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "p1.png", type: "image/png" },
      { name: "files[]", value: tinyPng(), filename: "p2.png", type: "image/png" },
      { name: "files[]", value: tinyPng(), filename: "p3.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("vision");
    expect(body.metadata.frameCount).toBe(3);
    expect(body.metadata.generationId).toBe("site_brief_gen_multi");
    expect(mockBriefFromFrames).toHaveBeenCalledTimes(1);
    const call = mockBriefFromFrames.mock.calls[0][0];
    expect(call.clientSlug).toBe("cftr");
    expect(call.userId).toBe("u_1");
    expect(call.userRole).toBe("sales");
    expect(call.frames).toHaveLength(3);
    expect(call.frames[0].mime).toBe("image/png");
    expect(call.frames[0].label).toBe("p1.png");
    expect(call.frames[2].label).toBe("p3.png");
    // Learning-loop analytics fired so the brain sees the request shape.
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_multi_frame_requested",
      "u_1",
      "sales",
      expect.objectContaining({ frame_count: 3, client_slug: "cftr" }),
    );
  });

  it("rejects 11 frames with 400 too_many_frames + analytics", async () => {
    const parts: {
      name: string;
      value: string | Uint8Array;
      filename?: string;
      type?: string;
    }[] = [];
    for (let i = 0; i < 11; i++) {
      parts.push({
        name: "files[]",
        value: tinyPng(),
        filename: `p${i}.png`,
        type: "image/png",
      });
    }
    parts.push({ name: "clientSlug", value: "cftr" });
    const req = makeMultipartReq(parts);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("too_many_frames");
    expect(body.error).toMatch(/too many frames/i);
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_multi_frame_rejected",
      "u_1",
      "sales",
      expect.objectContaining({
        reason: "too_many_frames",
        frame_count: 11,
      }),
    );
  });

  it("rejects a set containing a non-image/PDF frame with 400 unsupported_mime", async () => {
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "p1.png", type: "image/png" },
      {
        name: "files[]",
        value: new Uint8Array([0, 1, 2]),
        filename: "p2.dmg",
        type: "application/x-apple-diskimage",
      },
      { name: "files[]", value: tinyPng(), filename: "p3.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("unsupported_mime");
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_multi_frame_rejected",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "unsupported_mime" }),
    );
  });

  it("rejects total payload > 10 MB with 413 too_large", async () => {
    // Two 6-MB files → 12 MB total, trips the aggregate gate.
    const big = new Uint8Array(6 * 1024 * 1024);
    const req = makeMultipartReq([
      { name: "files[]", value: big, filename: "p1.png", type: "image/png" },
      { name: "files[]", value: big, filename: "p2.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.reason).toBe("too_large");
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
  });

  it("single file under `files[]` collapses to single-file path (briefFromImage)", async () => {
    mockBriefFromImage.mockResolvedValueOnce({
      ...HAPPY_FRAMES_RESULT,
      generationId: "site_brief_gen_solo",
    });
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "only.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata.frameCount).toBe(1);
    expect(mockBriefFromImage).toHaveBeenCalledTimes(1);
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
  });

  it("surfaces a briefFromFrames unsupported_mime reject as 400", async () => {
    // Simulate the extractor itself rejecting a frame (e.g. corrupted
    // image) — we route its `unsupported_mime` reason as 400 so the UI
    // can re-prompt for valid files.
    mockBriefFromFrames.mockRejectedValueOnce(
      Object.assign(new Error("bad frame"), {
        name: "BriefFromImageError",
        reason: "unsupported_mime",
      }),
    );
    // Re-mock so instanceof works in the route
    const mod = jest.requireMock("@/lib/brief-from-image") as {
      BriefFromImageError: new (m: string, r: string) => Error;
    };
    mockBriefFromFrames.mockReset();
    mockBriefFromFrames.mockRejectedValueOnce(
      new mod.BriefFromImageError("bad frame", "unsupported_mime"),
    );
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "p1.png", type: "image/png" },
      { name: "files[]", value: tinyPng(), filename: "p2.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("unsupported_mime");
  });

  it("returns 401 when unauthenticated (multi-frame)", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "p1.png", type: "image/png" },
      { name: "files[]", value: tinyPng(), filename: "p2.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
    expect(mockBriefFromImage).not.toHaveBeenCalled();
  });

  it("returns 400 when clientSlug is missing from a multi-frame upload", async () => {
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "p1.png", type: "image/png" },
      { name: "files[]", value: tinyPng(), filename: "p2.png", type: "image/png" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
  });

  it("rejects invalid clientSlug format with 400 (multi-frame)", async () => {
    const req = makeMultipartReq([
      { name: "files[]", value: tinyPng(), filename: "p1.png", type: "image/png" },
      { name: "files[]", value: tinyPng(), filename: "p2.png", type: "image/png" },
      { name: "clientSlug", value: "UPPER_CASE" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockBriefFromFrames).not.toHaveBeenCalled();
  });
});

/**
 * /api/sites/parse-brief — image / PDF path contract tests.
 *
 * Covers:
 *  - valid image/png → 200 + source:"vision" + metadata shape
 *  - application/pdf  → 200 + source:"vision"
 *  - oversized (>10 MB) → 413 + site.brief_image_rejected analytics
 *  - unsupported MIME → 415
 *  - missing API key (ai_not_configured) → 503 + reason
 *  - vision service unavailable → 502
 *  - auth gate still applies
 *
 * Text path is covered by the existing parseBrief tests in
 * brief-parser.test.ts; this file only exercises the new image branch
 * + the dispatch logic that decides between the two.
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

// A mirrored error-class trio matches what the real module exports so
// `instanceof` inside the route still matches. Jest hoists jest.mock so
// these classes need to be defined inside the factory closure.
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
import {
  BriefFromImageError,
  BriefFromImageAIUnavailableError,
  BriefFromImageNotConfiguredError,
} from "@/lib/brief-from-image";

const AUTH = { id: "u_1", role: "sales", name: "User", email: "u@x" };

function makeMultipartReq(parts: {
  name: string;
  value: string | Uint8Array;
  filename?: string;
  type?: string;
}[]): NextRequest {
  const fd = new FormData();
  for (const p of parts) {
    if (typeof p.value === "string") {
      fd.append(p.name, p.value);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const FileCtor: any = (globalThis as any).File;
    if (typeof FileCtor === "function") {
      const file = new FileCtor([p.value], p.filename ?? "unnamed.bin", {
        type: p.type ?? "application/octet-stream",
      });
      fd.append(p.name, file);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue(AUTH);
});

describe("parse-brief route — image path", () => {
  it("happy path: png file → 200 with source:'vision' + metadata", async () => {
    mockBriefFromImage.mockResolvedValueOnce({
      generationId: "site_brief_gen_abc",
      brief: {
        client: "cftr",
        product: { name: "CFTR" },
        pages: [
          {
            route: "/",
            sections: [{ type: "hero", heading: "Hi" }],
          },
        ],
      },
      metrics: {
        latencyMs: 500,
        tokensIn: 400,
        tokensOut: 200,
        costCents: 3,
        model: "claude-haiku-4-5-20251001",
      },
      extractedColors: ["#123456", "#abcdef"],
      detectedFont: "Inter",
      confidence: "high",
    });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const req = makeMultipartReq([
      { name: "file", value: pngBytes, filename: "w.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("vision");
    expect(body.brief.client).toBe("cftr");
    expect(body.metadata.generationId).toBe("site_brief_gen_abc");
    expect(body.metadata.extractedColors).toEqual(["#123456", "#abcdef"]);
    expect(body.metadata.detectedFont).toBe("Inter");
    expect(body.metadata.latencyMs).toBe(500);
    expect(body.metadata.model).toBe("claude-haiku-4-5-20251001");
    expect(mockBriefFromImage).toHaveBeenCalledWith(
      expect.objectContaining({
        mime: "image/png",
        clientSlug: "cftr",
        userId: "u_1",
        userRole: "sales",
      }),
    );
    expect(mockParseBrief).not.toHaveBeenCalled();
  });

  it("PDF path also routes through briefFromImage", async () => {
    mockBriefFromImage.mockResolvedValueOnce({
      generationId: "site_brief_gen_pdf",
      brief: {
        client: "cftr",
        product: { name: "CFTR" },
        pages: [
          { route: "/", sections: [{ type: "hero", heading: "Hi" }] },
        ],
      },
      metrics: {
        latencyMs: 400,
        tokensIn: 100,
        tokensOut: 50,
        costCents: 1,
        model: "claude-haiku-4-5-20251001",
      },
      extractedColors: [],
      detectedFont: null,
      confidence: "medium",
    });
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        filename: "w.pdf",
        type: "application/pdf",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("vision");
  });

  it("returns 413 when image is larger than 10 MB", async () => {
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    const req = makeMultipartReq([
      { name: "file", value: huge, filename: "big.png", type: "image/png" },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/);
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_image_rejected",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "too_large" }),
    );
    expect(mockBriefFromImage).not.toHaveBeenCalled();
  });

  it("returns 415 for an unsupported MIME type", async () => {
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0]),
        filename: "x.dmg",
        type: "application/x-apple-diskimage",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(415);
    expect(mockBriefFromImage).not.toHaveBeenCalled();
  });

  it("returns 503 with reason:'ai_not_configured' when the API key is missing", async () => {
    mockBriefFromImage.mockRejectedValueOnce(
      new BriefFromImageNotConfiguredError(),
    );
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x89, 0x50]),
        filename: "w.png",
        type: "image/png",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("ai_not_configured");
  });

  it("returns 502 when the vision model is unavailable", async () => {
    mockBriefFromImage.mockRejectedValueOnce(
      new BriefFromImageAIUnavailableError(),
    );
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x89, 0x50]),
        filename: "w.png",
        type: "image/png",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.reason).toBe("ai_unavailable");
  });

  it("returns 422 when vision output is bad JSON", async () => {
    mockBriefFromImage.mockRejectedValueOnce(
      new BriefFromImageError("bad output", "bad_ai_output"),
    );
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x89, 0x50]),
        filename: "w.png",
        type: "image/png",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe("bad_ai_output");
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x89, 0x50]),
        filename: "w.png",
        type: "image/png",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockBriefFromImage).not.toHaveBeenCalled();
  });

  it("returns 400 when clientSlug is missing from multipart", async () => {
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x89, 0x50]),
        filename: "w.png",
        type: "image/png",
      },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects invalid clientSlug format with 400", async () => {
    const req = makeMultipartReq([
      {
        name: "file",
        value: new Uint8Array([0x89, 0x50]),
        filename: "w.png",
        type: "image/png",
      },
      { name: "clientSlug", value: "UPPER" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("parse-brief route — text path still works", () => {
  it("falls through to parseBrief() when a text/html file is uploaded", async () => {
    mockParseBrief.mockResolvedValueOnce({
      brief: {
        client: "cftr",
        product: { name: "X" },
        pages: [{ route: "/", sections: [{ type: "hero", heading: "Hi" }] }],
      },
      source: "heuristic",
      tokensUsed: 0,
      confidence: "high",
    });
    const req = makeMultipartReq([
      {
        name: "file",
        value: new TextEncoder().encode("<h1>Hi</h1>"),
        filename: "x.html",
        type: "text/html",
      },
      { name: "clientSlug", value: "cftr" },
    ]);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("heuristic");
    expect(mockBriefFromImage).not.toHaveBeenCalled();
  });

  it("still handles the JSON body branch", async () => {
    mockParseBrief.mockResolvedValueOnce({
      brief: {
        client: "cftr",
        product: { name: "X" },
        pages: [{ route: "/", sections: [{ type: "hero", heading: "Hi" }] }],
      },
      source: "ai",
      tokensUsed: 120,
      confidence: "high",
    });
    const req = new NextRequest("http://test/api/sites/parse-brief", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer t",
      },
      body: JSON.stringify({ rawInput: "hi", clientSlug: "cftr" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("ai");
    expect(mockBriefFromImage).not.toHaveBeenCalled();
  });
});

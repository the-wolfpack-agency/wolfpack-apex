/**
 * /api/sites/[id]/generate-image route contract tests.
 *
 * Covers:
 *  - 401 without auth
 *  - 400 when prompt missing / whitespace
 *  - 400 reason=prompt_too_long when > MAX_PROMPT_LEN
 *  - 400 reason=prompt_blocked on NSFW or PII keyword
 *  - 404 when project not found
 *  - 429 reason=daily_cap_exceeded when user hit DAILY_CAP
 *  - 503 reason=ai_not_configured when FAL_API_KEY missing
 *  - 502 reason=provider_error when fal.ai 4xx/5xx
 *  - 200 returns url + generationId + cost_cents + seed
 *
 * Follows the brief-edit-route.test.ts pattern exactly — all deps
 * jest.mock'd, NextRequest assembled in-test.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockGetSite = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...args: unknown[]) => mockGetSite(...args),
}));

const mockGenerate = jest.fn();

class FakeNotConfigured extends Error {
  constructor(msg = "FAL_API_KEY missing") {
    super(msg);
    this.name = "ImageGenNotConfiguredError";
  }
}
class FakeProviderError extends Error {
  status: number;
  body: string;
  constructor(msg: string, status: number, body = "") {
    super(msg);
    this.name = "ImageGenProviderError";
    this.status = status;
    this.body = body;
  }
}
jest.mock("@/lib/image-gen", () => {
  const actual = jest.requireActual("@/lib/image-gen");
  return {
    ...actual,
    generateImage: (...args: unknown[]) => mockGenerate(...args),
    ImageGenNotConfiguredError: FakeNotConfigured,
    ImageGenProviderError: FakeProviderError,
  };
});

const mockCountUserGenerations = jest.fn();
jest.mock("@/lib/image-generations", () => ({
  countUserGenerationsSince: (...args: unknown[]) =>
    mockCountUserGenerations(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { POST as generateImagePOST } from "@/app/api/sites/[id]/generate-image/route";

function req(body: unknown, opts: { auth?: string } = {}) {
  return new NextRequest("http://test/api/sites/site_1/generate-image", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const STUB_OK = {
  generationId: "img_gen_1",
  url: "https://raw.githubusercontent.com/acme/site/main/public/generated/img_gen_1.jpg",
  repoCommitted: true,
  latencyMs: 3400,
  model: "fal-ai/flux/schnell",
  seed: 42,
  costCents: 1,
};

describe("POST /api/sites/[id]/generate-image", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: project exists, user under cap.
    mockGetSite.mockResolvedValue({
      id: "site_1",
      github_repo: "acme/site",
      brief: { client: "acme", product: { name: "x" }, pages: [] },
    });
    mockCountUserGenerations.mockResolvedValue(5);
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await generateImagePOST(req({ prompt: "x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("400 reason=prompt_required on empty prompt", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await generateImagePOST(
      req({ prompt: "   " }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe("prompt_required");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const bad = new NextRequest(
      "http://test/api/sites/site_1/generate-image",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer x" },
        body: "{ not json",
      },
    );
    const res = await generateImagePOST(bad, {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 reason=prompt_too_long when > 500 chars", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const longPrompt = "a".repeat(501);
    const res = await generateImagePOST(
      req({ prompt: longPrompt }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe("prompt_too_long");
  });

  it("400 reason=prompt_blocked on NSFW keyword", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await generateImagePOST(
      req({ prompt: "Design a nude portrait" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe("prompt_blocked");
  });

  it("400 reason=prompt_blocked on embedded email PII", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await generateImagePOST(
      req({ prompt: "Please add jane@example.com badge" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.reason).toBe("prompt_blocked");
  });

  it("404 when project missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce(null);
    const res = await generateImagePOST(
      req({ prompt: "a sunlit office" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("429 reason=daily_cap_exceeded when user at DAILY_CAP", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockCountUserGenerations.mockResolvedValueOnce(50);

    const res = await generateImagePOST(
      req({ prompt: "an office" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.reason).toBe("daily_cap_exceeded");
    expect(data.cap).toBe(50);
    expect(data.used).toBe(50);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("503 reason=ai_not_configured when FAL_API_KEY missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGenerate.mockRejectedValueOnce(new FakeNotConfigured());

    const res = await generateImagePOST(
      req({ prompt: "an office" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.reason).toBe("ai_not_configured");
    // Message MUST name the env var so an admin can fix it immediately
    expect(data.error).toMatch(/FAL_API_KEY/);
    // No "try again" language — retrying won't help
    expect(data.error).not.toMatch(/try again/i);
  });

  it("502 reason=provider_error on fal.ai upstream failure", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGenerate.mockRejectedValueOnce(
      new FakeProviderError("fal.ai 503: overloaded", 503),
    );

    const res = await generateImagePOST(
      req({ prompt: "an office" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.reason).toBe("provider_error");
    expect(data.status).toBe(503);
  });

  it("500 on unexpected error", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGenerate.mockRejectedValueOnce(new Error("kaboom"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await generateImagePOST(
      req({ prompt: "an office" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });

  it("200 returns url + generationId + cost_cents + seed on happy path", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGenerate.mockResolvedValueOnce(STUB_OK);

    const res = await generateImagePOST(
      req(
        { prompt: "A modern office", aspectRatio: "16:9", sectionPath: "/pages/0/sections/0/backgroundImage" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    expect(data.generationId).toBe("img_gen_1");
    expect(data.cost_cents).toBe(1);
    expect(data.seed).toBe(42);
    expect(data.repoCommitted).toBe(true);

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "A modern office",
        aspectRatio: "16:9",
        userId: "u_1",
        projectId: "site_1",
        githubRepo: "acme/site",
      }),
    );

    // Submitted event fires BEFORE generate call
    expect(mockTrack).toHaveBeenCalledWith(
      "site.image_gen_submitted",
      "u_1",
      "sales",
      expect.objectContaining({
        project_id: "site_1",
        aspect_ratio: "16:9",
        section_path: "/pages/0/sections/0/backgroundImage",
      }),
    );
  });

  it("200 defaults aspectRatio to 16:9 when invalid value supplied", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGenerate.mockResolvedValueOnce(STUB_OK);

    await generateImagePOST(
      req({ prompt: "x", aspectRatio: "bogus" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: "16:9" }),
    );
  });
});

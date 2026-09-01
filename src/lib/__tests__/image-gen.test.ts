/**
 * image-gen library unit tests.
 *
 * Covers:
 *  - generateImage happy path (fal.ai call + github commit + persistence row)
 *  - fallback path when project has no github_repo (returns fal CDN URL)
 *  - fal.ai 4xx/5xx → ImageGenProviderError, still persists a failed row
 *  - FAL_API_KEY missing → ImageGenNotConfiguredError, no persistence
 *  - repo commit failure is tolerated (user still gets fal URL, event emitted)
 *  - analytics fires on both success and failure
 *  - checkPrompt: length, blocked keywords, PII regex
 *
 * All external deps (analytics, db, github-client) are mocked — this
 * suite is pure function testing. No network, no DB.
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockInsert = jest.fn();
jest.mock("@/lib/image-generations", () => ({
  insertImageGeneration: (...args: unknown[]) => mockInsert(...args),
}));

const mockPutFile = jest.fn();
const mockDefaultClient = jest.fn();
jest.mock("@/lib/github-client", () => ({
  putFile: (...args: unknown[]) => mockPutFile(...args),
  defaultGithubClient: (...args: unknown[]) => mockDefaultClient(...args),
}));

import {
  generateImage,
  checkPrompt,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  IMAGE_GEN_MODEL,
  MAX_PROMPT_LEN,
} from "@/lib/image-gen";

const ORIGINAL_ENV = { ...process.env };

function falResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      images: [{ url: "https://cdn.fal.ai/generated/abc.jpg", width: 1024, height: 576 }],
      seed: 42,
      ...overrides,
    }),
    text: async () => "",
  };
}

function bytesResponse() {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, FAL_API_KEY: "test-key" };
  mockDefaultClient.mockReturnValue({ token: "gh-token", fetch: jest.fn() });
  mockInsert.mockResolvedValue(undefined);
  mockPutFile.mockResolvedValue(undefined);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("generateImage — happy path", () => {
  it("calls fal.ai with the expected request shape + returns repo-committed URL", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(falResponse()) // fal.ai
      .mockResolvedValueOnce(bytesResponse()); // image bytes

    const result = await generateImage({
      prompt: "A modern office",
      aspectRatio: "16:9",
      userId: "u_1",
      userRole: "sales",
      projectId: "site_1",
      githubRepo: "the-wolfpack-agency/cftr",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // fal.ai call
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://fal.run/fal-ai/flux/schnell",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Key test-key",
          "Content-Type": "application/json",
        }),
        body: expect.stringContaining("A modern office"),
      }),
    );
    // Second fetch was the CDN bytes
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://cdn.fal.ai/generated/abc.jpg",
    );

    // putFile called with base64-safe Buffer + repo path
    expect(mockPutFile).toHaveBeenCalledWith(
      expect.objectContaining({ token: "gh-token" }),
      "the-wolfpack-agency/cftr",
      expect.stringMatching(/^public\/generated\/img_gen_.*\.jpg$/),
      expect.any(Buffer),
      expect.stringContaining("generated image img_gen_"),
    );

    // Returns raw.githubusercontent.com URL
    expect(result.url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/the-wolfpack-agency\/cftr\/main\/public\/generated\/img_gen_/,
    );
    expect(result.repoCommitted).toBe(true);
    expect(result.model).toBe(IMAGE_GEN_MODEL);
    expect(result.seed).toBe(42);
    expect(result.costCents).toBeGreaterThan(0);

    // Persistence row inserted with expected shape
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.generationId,
        projectId: "site_1",
        requestedBy: "u_1",
        prompt: "A modern office",
        aspectRatio: "16:9",
        seed: 42,
        model: IMAGE_GEN_MODEL,
        repoCommitted: true,
        costCents: expect.any(Number),
        latencyMs: expect.any(Number),
      }),
    );

    // Success event emitted
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.image_gen_succeeded",
      "u_1",
      "sales",
      expect.objectContaining({
        project_id: "site_1",
        aspect_ratio: "16:9",
        repo_committed: true,
      }),
    );
  });

  it("passes seed through to fal.ai when provided", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(falResponse({ seed: 99 }))
      .mockResolvedValueOnce(bytesResponse());

    await generateImage({
      prompt: "x",
      aspectRatio: "1:1",
      seed: 99,
      userId: "u_1",
      userRole: "sales",
      projectId: "site_1",
      githubRepo: "acme/site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.seed).toBe(99);
    expect(body.image_size).toBe("square_hd");
  });
});

describe("generateImage — no github_repo fallback", () => {
  it("returns fal CDN URL + repoCommitted=false when project not provisioned", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(falResponse());

    const result = await generateImage({
      prompt: "draft prompt",
      userId: "u_1",
      userRole: "sales",
      projectId: "site_draft",
      githubRepo: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // only fal, no bytes download
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(result.url).toBe("https://cdn.fal.ai/generated/abc.jpg");
    expect(result.repoCommitted).toBe(false);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ repoCommitted: false }),
    );
  });
});

describe("generateImage — provider errors", () => {
  it("throws ImageGenProviderError on 4xx and inserts a failed row", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => '{"detail":"bad prompt"}',
      json: async () => ({ detail: "bad prompt" }),
    });

    await expect(
      generateImage({
        prompt: "x",
        userId: "u_1",
        userRole: "sales",
        projectId: "site_1",
        githubRepo: "acme/site",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ImageGenProviderError);

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "",
        repoCommitted: false,
        costCents: 0,
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.image_gen_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "provider_422" }),
    );
  });

  it("throws ImageGenProviderError on 5xx", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "upstream down",
      json: async () => ({}),
    });

    await expect(
      generateImage({
        prompt: "x",
        userId: "u_1",
        userRole: "sales",
        projectId: "site_1",
        githubRepo: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("throws provider error on empty images array", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ images: [] }),
      text: async () => "",
    });

    await expect(
      generateImage({
        prompt: "x",
        userId: "u_1",
        userRole: "sales",
        projectId: "site_1",
        githubRepo: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ImageGenProviderError);
  });
});

describe("generateImage — preflight config check", () => {
  it("throws ImageGenNotConfiguredError when FAL_API_KEY missing", async () => {
    delete process.env.FAL_API_KEY;
    const fetchImpl = jest.fn();

    await expect(
      generateImage({
        prompt: "x",
        userId: "u_1",
        userRole: "sales",
        projectId: "site_1",
        githubRepo: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ImageGenNotConfiguredError);

    // No external call made
    expect(fetchImpl).not.toHaveBeenCalled();
    // No row persisted (nothing happened)
    expect(mockInsert).not.toHaveBeenCalled();
    // But analytics still captures the config failure
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.image_gen_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "not_configured" }),
    );
  });
});

describe("generateImage — repo commit failure is non-fatal", () => {
  it("returns fal URL + repoCommitted=false when putFile throws", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(falResponse())
      .mockResolvedValueOnce(bytesResponse());
    mockPutFile.mockRejectedValueOnce(new Error("gh 403"));

    const result = await generateImage({
      prompt: "x",
      userId: "u_1",
      userRole: "sales",
      projectId: "site_1",
      githubRepo: "acme/site",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.repoCommitted).toBe(false);
    expect(result.url).toBe("https://cdn.fal.ai/generated/abc.jpg");
    // Failed commit event emitted so ops can alert on it
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.image_gen_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "repo_commit_failed" }),
    );
    // Success event STILL fires — user is not blocked
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.image_gen_succeeded",
      "u_1",
      "sales",
      expect.objectContaining({ repo_committed: false }),
    );
  });
});

describe("checkPrompt — input validation", () => {
  it("accepts a normal prompt", () => {
    expect(checkPrompt("A sunlit office with plants")).toEqual({ ok: true });
  });

  it("rejects empty / whitespace", () => {
    expect(checkPrompt("")).toEqual({ ok: false, reason: "prompt_empty" });
    expect(checkPrompt("   ")).toEqual({ ok: false, reason: "prompt_empty" });
  });

  it("rejects prompts longer than MAX_PROMPT_LEN", () => {
    const tooLong = "x".repeat(MAX_PROMPT_LEN + 1);
    const res = checkPrompt(tooLong);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("prompt_too_long");
  });

  it("blocks NSFW keywords", () => {
    const res = checkPrompt("A photorealiztic nude portrait");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("prompt_blocked");
  });

  it("blocks embedded email PII", () => {
    const res = checkPrompt("Design a mockup for contact me at john@example.com");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("prompt_blocked");
  });

  it("blocks embedded phone PII", () => {
    const res = checkPrompt("Call 555-123-4567 poster");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("prompt_blocked");
  });
});

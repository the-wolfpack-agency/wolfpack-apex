/**
 * sharepoint-upload — unit tests.
 *
 * Covers the four published outcomes of `uploadClassSummary`:
 *
 *   1. happy path        → 201, returns web_url from Graph response
 *   2. not_configured    → env vars missing, returns skipped_reason
 *   3. no_token          → getValidToken returns null for both anchors
 *   4. graph_error 401   → upload PUT returns 401 with body
 *   5. graph_error 500   → upload PUT returns 500 with body
 *
 * Plus the buildUploadUrl shape so the exact URL format is locked in by
 * test (covers folder path with spaces + filename with extension).
 */

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

/* sharepoint-upload now reads the config-repo first and falls back to
   env vars. These tests exercise the env-var fallback path; pin
   getSharepointConfig to null so the DB tier never runs. */
jest.mock("@/lib/automations/porsche-classes/config-repo", () => ({
  getSharepointConfig: jest.fn(async () => null),
}));

import {
  uploadClassSummary,
  buildUploadUrl,
} from "@/lib/automations/porsche-classes/sharepoint-upload";

const ORIGINAL_ENV = { ...process.env };

function setEnv() {
  process.env.INSTINCT_SHAREPOINT_SITE_ID =
    "contoso.sharepoint.com,abc123,def456";
  process.env.INSTINCT_SHAREPOINT_DRIVE_ID = "drive-789";
  process.env.INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH =
    "PCNA Brand Ambassador/2026 Brand Ambassador/Class Summaries";
}

function clearEnv() {
  delete process.env.INSTINCT_SHAREPOINT_SITE_ID;
  delete process.env.INSTINCT_SHAREPOINT_DRIVE_ID;
  delete process.env.INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset env to a known-clean baseline for each test.
  process.env = { ...ORIGINAL_ENV };
  clearEnv();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("buildUploadUrl", () => {
  it("encodes folder segments + filename and preserves slashes between segments", () => {
    const url = buildUploadUrl(
      {
        siteId: "contoso.sharepoint.com,abc123,def456",
        driveId: "drive-789",
        folderPath: "PCNA Brand Ambassador/2026 Brand Ambassador/Class Summaries",
      },
      "BA101 - 2026-04-13 - Westlake.docx",
    );
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/sites/" +
        encodeURIComponent("contoso.sharepoint.com,abc123,def456") +
        "/drives/drive-789" +
        "/root:/PCNA%20Brand%20Ambassador/2026%20Brand%20Ambassador/Class%20Summaries" +
        "/BA101%20-%202026-04-13%20-%20Westlake.docx:/content",
    );
  });

  it("strips a leading and trailing slash from the folder path", () => {
    const url = buildUploadUrl(
      {
        siteId: "site-id",
        driveId: "drive-id",
        folderPath: "Class Summaries",
      },
      "x.docx",
    );
    // Note no double slash before "Class".
    expect(url).toContain("/root:/Class%20Summaries/x.docx:/content");
  });
});

describe("uploadClassSummary", () => {
  const baseArgs = {
    userId: "u-1",
    userEmail: "alicia@example.com",
    filename: "BA101 - 2026-04-13 - Westlake.docx",
    bytes: Buffer.from("hello"),
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  it("returns not_configured when env vars are missing", async () => {
    // env is already cleared by beforeEach
    const out = await uploadClassSummary(baseArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.skipped_reason).toBe("not_configured");
      expect(out.error).toMatch(/SharePoint not configured/);
    }
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });

  it("returns no_token when both userId and userEmail lookups fail", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValue(null);
    const out = await uploadClassSummary(baseArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.skipped_reason).toBe("no_token");
    }
    expect(mockGetValidToken).toHaveBeenCalledWith("u-1");
    expect(mockGetValidToken).toHaveBeenCalledWith("alicia@example.com");
  });

  it("happy path — PUT 201 returns web_url", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "alicia@example.com",
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "01ABC",
          name: baseArgs.filename,
          webUrl: "https://contoso.sharepoint.com/sites/x/Shared/file.docx",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    const out = await uploadClassSummary(baseArgs);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.web_url).toBe(
        "https://contoso.sharepoint.com/sites/x/Shared/file.docx",
      );
    }

    // Verify the URL was the PUT we expect.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(typeof calledUrl).toBe("string");
    expect(calledUrl).toContain(":/content");
    expect(calledUrl).toContain("BA101%20-%202026-04-13%20-%20Westlake.docx");
    expect(init).toBeDefined();
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("PUT");
    const headers = initObj.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    expect(headers["Content-Type"]).toBe(baseArgs.contentType);
    fetchSpy.mockRestore();
  });

  it("graph_error 401 surfaces the status + body", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "alicia@example.com",
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("token expired", { status: 401 }),
    );
    const out = await uploadClassSummary(baseArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.skipped_reason).toBe("graph_error");
      expect(out.status).toBe(401);
      expect(out.error).toMatch(/401/);
      expect(out.error).toMatch(/token expired/);
    }
    fetchSpy.mockRestore();
  });

  it("graph_error 500 surfaces the status + body", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "alicia@example.com",
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("upstream blew up", { status: 500 }),
    );
    const out = await uploadClassSummary(baseArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.skipped_reason).toBe("graph_error");
      expect(out.status).toBe(500);
      expect(out.error).toMatch(/500/);
    }
    fetchSpy.mockRestore();
  });

  it("network error becomes graph_error skipped_reason without throwing", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "alicia@example.com",
    });
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const out = await uploadClassSummary(baseArgs);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.skipped_reason).toBe("graph_error");
      expect(out.error).toMatch(/ECONNRESET/);
    }
    fetchSpy.mockRestore();
  });

  it("rejects filenames containing path separators (anti-traversal)", async () => {
    setEnv();
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok-abc",
      userEmail: "alicia@example.com",
    });
    const out = await uploadClassSummary({
      ...baseArgs,
      filename: "../etc/passwd",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.skipped_reason).toBe("graph_error");
      expect(out.error).toMatch(/invalid filename/);
    }
    // No token lookup — early reject.
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });
});

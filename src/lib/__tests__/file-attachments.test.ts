/**
 * File Attachment Tests -- Validation, security, sanitization, analytics.
 *
 * Tests cover:
 *   - File type allowlisting (extension + MIME)
 *   - Size limits and empty file rejection
 *   - Text content sanitization (null bytes, truncation)
 *   - Max file count enforcement
 *   - Duplicate file rejection
 *   - Attachment metadata in API body
 *   - Analytics event tracking for file attachments
 *   - File context prepended to messages correctly
 *   - 401 handling with attachments
 */

 

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();
const mockChat = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/assistant", () => ({
  chat: (...args: any[]) => mockChat(...args),
  getConversations: jest.fn().mockResolvedValue([]),
  getConversationMessages: jest.fn().mockResolvedValue([]),
  rateMessage: jest.fn().mockResolvedValue(true),
  archiveConversation: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (authHeader: string | null) => {
    if (authHeader === "Bearer valid-token") {
      return { id: "test-user", email: "test@wolfpack.dev", name: "Test", role: "cto", created_at: "" };
    }
    return null;
  },
}));

// ---------------------------------------------------------------------------
// File validation logic (extracted for testability)
// These mirror the constants and functions in InstinctChat.tsx
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 512_000;
const MAX_FILES = 5;
const MAX_TEXT_LENGTH = 50_000;
const ALLOWED_EXTENSIONS = new Set([
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".rtf", ".odt", ".ods", ".odp",
  // Text & data
  ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm",
  ".css", ".log", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".env.example",
  // Code
  ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
  ".java", ".php", ".swift", ".kt", ".sql", ".sh", ".bash",
  ".zsh", ".r", ".m", ".h", ".c", ".cpp", ".cs",
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  // Design & media
  ".sketch", ".fig",
]);
const ALLOWED_MIME_PREFIXES = [
  "text/",
  "application/json", "application/xml",
  "application/x-yaml", "application/yaml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument",
  "application/rtf",
  "image/",
];

function isAllowedFile(file: { name: string; type: string; size: number }): string | null {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `"${file.name}" has an unsupported file type`;
  }
  if (file.type && !ALLOWED_MIME_PREFIXES.some((p) => file.type.startsWith(p))) {
    return `"${file.name}" has an unexpected content type`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `"${file.name}" exceeds the 512KB limit`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty`;
  }
  return null;
}

function sanitizeTextContent(text: string): string {
  let sanitized = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "\n\n[Truncated]" : text;
  sanitized = sanitized.replace(/\0/g, "");
  return sanitized;
}

function buildMessageWithContext(
  message: string,
  attachments: { name: string; type: string; content: string }[],
): string {
  const fileContext = attachments
    .filter((f) => !f.type.startsWith("image/"))
    .map((f) => `--- File: ${f.name} ---\n${f.content}`)
    .join("\n\n");
  if (fileContext) {
    return `${fileContext}\n\n---\n\n${message}`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Tests -- File Validation
// ---------------------------------------------------------------------------

describe("File Attachment Validation", () => {
  describe("Extension allowlist", () => {
    test("allows .txt files", () => {
      expect(isAllowedFile({ name: "readme.txt", type: "text/plain", size: 100 })).toBeNull();
    });

    test("allows .md files", () => {
      expect(isAllowedFile({ name: "notes.md", type: "text/markdown", size: 100 })).toBeNull();
    });

    test("allows .json files", () => {
      expect(isAllowedFile({ name: "config.json", type: "application/json", size: 200 })).toBeNull();
    });

    test("allows .py files", () => {
      expect(isAllowedFile({ name: "script.py", type: "text/x-python", size: 500 })).toBeNull();
    });

    test("allows .ts files", () => {
      expect(isAllowedFile({ name: "index.ts", type: "text/typescript", size: 300 })).toBeNull();
    });

    test("allows .tsx files", () => {
      expect(isAllowedFile({ name: "Component.tsx", type: "text/typescript", size: 300 })).toBeNull();
    });

    test("allows .csv files", () => {
      expect(isAllowedFile({ name: "data.csv", type: "text/csv", size: 1000 })).toBeNull();
    });

    test("allows .sql files", () => {
      expect(isAllowedFile({ name: "migration.sql", type: "text/plain", size: 400 })).toBeNull();
    });

    test("allows .yml files", () => {
      expect(isAllowedFile({ name: "docker-compose.yml", type: "application/x-yaml", size: 200 })).toBeNull();
    });

    test("allows .png images", () => {
      expect(isAllowedFile({ name: "screenshot.png", type: "image/png", size: 50000 })).toBeNull();
    });

    test("allows .jpg images", () => {
      expect(isAllowedFile({ name: "photo.jpg", type: "image/jpeg", size: 50000 })).toBeNull();
    });

    test("allows .svg images", () => {
      expect(isAllowedFile({ name: "icon.svg", type: "image/svg+xml", size: 2000 })).toBeNull();
    });

    test("rejects .exe files", () => {
      const err = isAllowedFile({ name: "malware.exe", type: "application/x-msdownload", size: 100 });
      expect(err).toContain("unsupported file type");
    });

    test("rejects .zip files", () => {
      const err = isAllowedFile({ name: "archive.zip", type: "application/zip", size: 100 });
      expect(err).toContain("unsupported file type");
    });

    test("rejects .dll files", () => {
      const err = isAllowedFile({ name: "system.dll", type: "application/x-msdownload", size: 100 });
      expect(err).toContain("unsupported file type");
    });

    test("rejects .env files (security)", () => {
      const err = isAllowedFile({ name: ".env", type: "text/plain", size: 100 });
      expect(err).toContain("unsupported file type");
    });

    test("rejects .pem files (security)", () => {
      const err = isAllowedFile({ name: "private.pem", type: "application/x-pem-file", size: 100 });
      expect(err).toContain("unsupported file type");
    });

    test("rejects .key files (security)", () => {
      const err = isAllowedFile({ name: "server.key", type: "application/x-pem-file", size: 100 });
      expect(err).toContain("unsupported file type");
    });

    test("allows .pdf files", () => {
      expect(isAllowedFile({ name: "document.pdf", type: "application/pdf", size: 100 })).toBeNull();
    });

    test("allows .docx files", () => {
      expect(isAllowedFile({ name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 100 })).toBeNull();
    });

    test("allows .xlsx files", () => {
      expect(isAllowedFile({ name: "data.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 100 })).toBeNull();
    });

    test("allows .pptx files", () => {
      expect(isAllowedFile({ name: "deck.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 100 })).toBeNull();
    });

    test("allows .doc files", () => {
      expect(isAllowedFile({ name: "old.doc", type: "application/msword", size: 100 })).toBeNull();
    });

    test("allows .go files", () => {
      expect(isAllowedFile({ name: "main.go", type: "text/plain", size: 100 })).toBeNull();
    });

    test("allows .rs files", () => {
      expect(isAllowedFile({ name: "lib.rs", type: "text/plain", size: 100 })).toBeNull();
    });

    test("allows .java files", () => {
      expect(isAllowedFile({ name: "App.java", type: "text/plain", size: 100 })).toBeNull();
    });

    test("allows .php files", () => {
      expect(isAllowedFile({ name: "index.php", type: "text/plain", size: 100 })).toBeNull();
    });
  });

  describe("MIME type validation", () => {
    test("rejects mismatched MIME type", () => {
      const err = isAllowedFile({ name: "data.csv", type: "application/octet-stream", size: 100 });
      expect(err).toContain("unexpected content type");
    });

    test("accepts empty MIME type (browser sometimes omits)", () => {
      expect(isAllowedFile({ name: "readme.txt", type: "", size: 100 })).toBeNull();
    });
  });

  describe("Size limits", () => {
    test("allows files under 512KB", () => {
      expect(isAllowedFile({ name: "small.txt", type: "text/plain", size: 100_000 })).toBeNull();
    });

    test("allows files at exactly 512KB", () => {
      expect(isAllowedFile({ name: "exact.txt", type: "text/plain", size: 512_000 })).toBeNull();
    });

    test("rejects files over 512KB", () => {
      const err = isAllowedFile({ name: "large.txt", type: "text/plain", size: 512_001 });
      expect(err).toContain("exceeds the 512KB limit");
    });

    test("rejects empty files", () => {
      const err = isAllowedFile({ name: "empty.txt", type: "text/plain", size: 0 });
      expect(err).toContain("is empty");
    });
  });

  describe("Max file count", () => {
    test("MAX_FILES is 5", () => {
      expect(MAX_FILES).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests -- Content Sanitization
// ---------------------------------------------------------------------------

describe("Content Sanitization", () => {
  test("strips null bytes from text", () => {
    const dirty = "hello\0world\0test";
    const clean = sanitizeTextContent(dirty);
    expect(clean).toBe("helloworldtest");
    expect(clean).not.toContain("\0");
  });

  test("truncates text over 50,000 characters", () => {
    const longText = "a".repeat(60_000);
    const result = sanitizeTextContent(longText);
    expect(result.length).toBeLessThan(60_000);
    expect(result).toContain("[Truncated]");
    expect(result.startsWith("a".repeat(50_000))).toBe(true);
  });

  test("preserves text under limit", () => {
    const text = "Hello, this is a normal file.";
    expect(sanitizeTextContent(text)).toBe(text);
  });

  test("handles empty string", () => {
    expect(sanitizeTextContent("")).toBe("");
  });

  test("strips null bytes and truncates combined", () => {
    const dirty = "\0".repeat(10) + "a".repeat(60_000);
    const result = sanitizeTextContent(dirty);
    expect(result).not.toContain("\0");
    expect(result).toContain("[Truncated]");
  });
});

// ---------------------------------------------------------------------------
// Tests -- Message Building with File Context
// ---------------------------------------------------------------------------

describe("Message Building with Attachments", () => {
  test("prepends text file content to message", () => {
    const attachments = [
      { name: "config.json", type: "application/json", content: '{"key": "value"}' },
    ];
    const result = buildMessageWithContext("What does this config do?", attachments);
    expect(result).toContain("--- File: config.json ---");
    expect(result).toContain('{"key": "value"}');
    expect(result).toContain("What does this config do?");
    // File context comes first
    expect(result.indexOf("config.json")).toBeLessThan(result.indexOf("What does"));
  });

  test("prepends multiple text files", () => {
    const attachments = [
      { name: "a.ts", type: "text/typescript", content: "const x = 1;" },
      { name: "b.ts", type: "text/typescript", content: "const y = 2;" },
    ];
    const result = buildMessageWithContext("Compare these files", attachments);
    expect(result).toContain("--- File: a.ts ---");
    expect(result).toContain("--- File: b.ts ---");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("const y = 2;");
  });

  test("skips image files in text context (images sent as base64 separately)", () => {
    const attachments = [
      { name: "screenshot.png", type: "image/png", content: "data:image/png;base64,..." },
    ];
    const result = buildMessageWithContext("What is in this image?", attachments);
    // Should NOT prepend image content as text
    expect(result).toBe("What is in this image?");
  });

  test("includes text files but skips images in mixed attachments", () => {
    const attachments = [
      { name: "code.ts", type: "text/typescript", content: "export function foo() {}" },
      { name: "screenshot.png", type: "image/png", content: "data:image/png;base64,..." },
    ];
    const result = buildMessageWithContext("Review this", attachments);
    expect(result).toContain("--- File: code.ts ---");
    expect(result).not.toContain("screenshot.png");
  });

  test("returns plain message when no attachments", () => {
    const result = buildMessageWithContext("Hello", []);
    expect(result).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Tests -- API Route (attachment tracking)
// ---------------------------------------------------------------------------

describe("API Route -- File Attachment Analytics", () => {
  let POST: (req: any) => Promise<any>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockChat.mockResolvedValue({
      response: "test response",
      source: "fallback",
      tokensUsed: 0,
      conversationId: "test-conv",
      messageId: "test-msg",
    });

    // Dynamic import to pick up mocks
    const routeModule = await import("@/app/api/assistant/route");
    POST = routeModule.POST;
  });

  function makeRequest(body: Record<string, unknown>, authHeader = "Bearer valid-token") {
    return {
      json: async () => body,
      url: "https://wolfpack-apex.vercel.app/api/assistant",
      headers: {
        get: (name: string) => (name === "authorization" ? authHeader : null),
      },
    };
  }

  test("tracks analytics event for each file attachment", async () => {
    const req = makeRequest({
      message: "Review this code",
      attachments: [
        { name: "index.ts", type: "text/typescript", size: 1234 },
        { name: "config.json", type: "application/json", size: 456 },
      ],
    });

    const res = await POST(req as any);
    const data = await res.json();
    expect(data.response).toBe("test response");

    // Should have tracked two file attachment events
    const attachCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.file_attached",
    );
    expect(attachCalls).toHaveLength(2);
    expect(attachCalls[0][3].file_name).toBe("index.ts");
    expect(attachCalls[0][3].file_type).toBe("text/typescript");
    expect(attachCalls[0][3].file_size).toBe(1234);
    expect(attachCalls[1][3].file_name).toBe("config.json");
  });

  test("works without attachments", async () => {
    /* Not "Hello": a bare greeting is now answered as a greeting, before
       any of the machinery this test is about. The fixture wanted "any
       message" and a greeting stopped being one. */
    const req = makeRequest({ message: "What is our refund policy?" });
    const res = await POST(req as any);
    const data = await res.json();
    expect(data.response).toBe("test response");

    // No attachment events
    const attachCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.file_attached",
    );
    expect(attachCalls).toHaveLength(0);
  });

  test("returns 401 without valid token", async () => {
    const req = makeRequest({ message: "Hello" }, "Bearer invalid-token");
    const res = await POST(req as any);
    expect(res.status).toBe(401);
  });

  test("returns 400 without message", async () => {
    const req = makeRequest({});
    const res = await POST(req as any);
    expect(res.status).toBe(400);
  });

  test("passes message to chat function", async () => {
    const req = makeRequest({ message: "Test message" });
    await POST(req as any);
    // The route calls chat(message, user.id, user.role, conversationId,
    // pageContext, user.workspaceId, geo, attachmentBlock, timeZone).
    // conversationId and pageContext are absent in this request, the mocked
    // user has no workspaceId, and the test request carries no x-vercel-ip-*
    // headers so readVercelGeo returns an empty object. This request has no
    // attachments, so the block is undefined — asserted rather than dropped,
    // so a future change that stops passing attachments through fails here.
    // timeZone is undefined for the same reason: this body carries none. A
    // real browser always sends one, and the tools format times with it.
    expect(mockChat).toHaveBeenCalledWith(
      "Test message",
      "test-user",
      "cto",
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
    );
  });

  /**
   * The attachment reaches the model.
   *
   * Reported 2026-08-04: attaching a screenshot and asking "look at the screen
   * shot" answered "I cannot view screenshots or attachments directly", while
   * ocrImage() had been reading screenshots for brain ingest all along.
   * `fileContents` arrived here complete with the image's base64 and was used
   * for the quality gate and one analytics event, then dropped.
   */
  test("an attachment's extracted text is passed to chat()", async () => {
    const req = makeRequest({
      message: "look at the screen shot",
      fileContents: [{ name: "notes.txt", content: "Q3 targets are 40 units" }],
    });
    await POST(req as any);

    const block = mockChat.mock.calls[0]?.[7];
    expect(block).toBeDefined();
    expect(block).toContain("Q3 targets are 40 units");
    expect(block).toContain("notes.txt");
  });

  test("no attachments passes undefined, not an empty string", async () => {
    const req = makeRequest({ message: "hello" });
    await POST(req as any);
    expect(mockChat.mock.calls[0]?.[7]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests -- Security Edge Cases
// ---------------------------------------------------------------------------

describe("Security Edge Cases", () => {
  test("path traversal in filename is blocked by extension check", () => {
    const err = isAllowedFile({ name: "../../../etc/passwd", type: "text/plain", size: 100 });
    expect(err).toContain("unsupported file type");
  });

  test("double extension .txt.exe is blocked", () => {
    const err = isAllowedFile({ name: "legit.txt.exe", type: "application/x-msdownload", size: 100 });
    expect(err).toContain("unsupported file type");
  });

  test("null byte in filename does not bypass validation", () => {
    const err = isAllowedFile({ name: "file.txt\0.exe", type: "text/plain", size: 100 });
    // The extension extracted is "exe" (after null byte), so it should be rejected
    // But since split(".").pop() gets "exe", this is correctly rejected
    expect(err).not.toBeNull();
  });

  test("extremely long filename is handled gracefully", () => {
    const longName = "a".repeat(1000) + ".txt";
    const result = isAllowedFile({ name: longName, type: "text/plain", size: 100 });
    expect(result).toBeNull(); // Allowed extension, just a long name
  });

  test("content with script tags is preserved as text (not executed)", () => {
    const content = '<script>alert("xss")</script>';
    const sanitized = sanitizeTextContent(content);
    // Text content is sent to AI as context, not rendered as HTML
    expect(sanitized).toBe(content);
  });

  test("content with SQL injection attempts is preserved as text", () => {
    const content = "'; DROP TABLE users; --";
    const sanitized = sanitizeTextContent(content);
    expect(sanitized).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Tests -- API Route Quality Gate Integration
// ---------------------------------------------------------------------------

describe("API Route -- Quality Gate Integration", () => {
  let POST: (req: any) => Promise<any>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockChat.mockResolvedValue({
      response: "test response",
      source: "fallback",
      tokensUsed: 0,
      conversationId: "test-conv",
      messageId: "test-msg",
    });
    const routeModule = await import("@/app/api/assistant/route");
    POST = routeModule.POST;
  });

  function makeRequest(body: Record<string, unknown>, authHeader = "Bearer valid-token") {
    return {
      json: async () => body,
      url: "https://wolfpack-instinct.vercel.app/api/assistant",
      headers: {
        get: (name: string) => (name === "authorization" ? authHeader : null),
      },
    };
  }

  test("rejects file with SSN and returns gate results", async () => {
    const req = makeRequest({
      message: "Check this doc",
      fileContents: [
        { name: "employees.csv", content: "Name,SSN\nJohn,123-45-6789\nJane,987-65-4321" },
      ],
    });

    const res = await POST(req as any);
    const data = await res.json();

    expect(data.source).toBe("quality_gate");
    expect(data.response).toBeNull();
    expect(data.gateResults).toBeDefined();
    expect(data.gateResults[0].verdict).toBe("reject");
    expect(data.gateResults[0].flags.some((f: any) => f.message.includes("SSN"))).toBe(true);

    // Should NOT have called chat
    expect(mockChat).not.toHaveBeenCalled();
  });

  test("rejects file with connection string", async () => {
    const req = makeRequest({
      message: "Review config",
      fileContents: [
        { name: ".env", content: "DATABASE_URL=postgres://admin:password@db.host.com:5432/production" },
      ],
    });

    const res = await POST(req as any);
    const data = await res.json();
    expect(data.source).toBe("quality_gate");
    expect(data.gateResults[0].verdict).toBe("reject");
    expect(mockChat).not.toHaveBeenCalled();
  });

  test("passes clean file and includes gate results", async () => {
    const req = makeRequest({
      message: "Analyze this report",
      fileContents: [
        { name: "report.md", content: "# Q3 Revenue Report\n\nRevenue increased 15% compared to Q2. Customer retention is at 94%." },
      ],
    });

    const res = await POST(req as any);
    const data = await res.json();

    // The route appends a "Go to: [Page](/route)" navigation line when
    // the exchange touches an in-app domain (here "report" -> /reports),
    // so the response is "test response" plus the appended link. Assert
    // the chat text is present rather than exact-equal.
    expect(data.response).toContain("test response");
    expect(data.gateResults).toBeDefined();
    expect(data.gateResults[0].verdict).toBe("pass");
    expect(mockChat).toHaveBeenCalled();
  });

  test("warns on file with email but still processes", async () => {
    const req = makeRequest({
      message: "Check contacts",
      fileContents: [
        { name: "contacts.txt", content: "Reach out to support@company.com about the Q3 deliverables and timeline for the project." },
      ],
    });

    const res = await POST(req as any);
    const data = await res.json();

    // Same appended navigation line as above ("contacts" -> /people), so
    // assert the chat text is contained rather than exact-equal.
    expect(data.response).toContain("test response");
    expect(data.gateResults[0].verdict).toBe("warn");
    expect(mockChat).toHaveBeenCalled();
  });

  test("tracks doc_quality_checked for every file", async () => {
    const req = makeRequest({
      message: "Review",
      fileContents: [
        { name: "a.md", content: "This is a clean document about our business strategy and roadmap for next quarter." },
        { name: "b.md", content: "Another perfectly normal document about team processes and workflow optimization." },
      ],
    });

    await POST(req as any);

    const qualityCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.doc_quality_checked",
    );
    expect(qualityCalls).toHaveLength(2);
  });

  test("tracks doc_ingested for passing files", async () => {
    const req = makeRequest({
      message: "Add this",
      fileContents: [
        { name: "guide.md", content: "Step by step guide for onboarding new team members to the Wolfpack platform." },
      ],
    });

    await POST(req as any);

    const ingestCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.doc_ingested",
    );
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0][3].file_name).toBe("guide.md");
  });

  test("tracks doc_rejected for failing files", async () => {
    const req = makeRequest({
      message: "Check",
      fileContents: [
        { name: "secrets.txt", content: "AWS key: AKIAIOSFODNN7EXAMPLE used for production access." },
      ],
    });

    await POST(req as any);

    const rejectCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.doc_rejected",
    );
    expect(rejectCalls).toHaveLength(1);
  });

  test("processes message without fileContents normally", async () => {
    /* Same reason as above: "Hello there" is a greeting now, and this
       test is about the quality gate rather than about greetings. */
    const req = makeRequest({ message: "What is our refund policy?" });
    const res = await POST(req as any);
    const data = await res.json();

    expect(data.response).toBe("test response");
    expect(data.gateResults).toBeUndefined();
    expect(mockChat).toHaveBeenCalled();
  });
});
export {};

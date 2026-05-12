/**
 * Document Generation Tests
 *
 * Tests zero-token doc generation: API docs from TS/Python, release notes
 * from git log, feature docs from DB data, save/get/download, analytics.
 */

 

import { trackEvent } from "@/lib/analytics";

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

// Mock fs and child_process for file reading and git log
const mockReadFileSync = jest.fn();
const mockExecFileSync = jest.fn();

jest.mock("fs", () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

jest.mock("child_process", () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

// Keep backward-compatible alias for existing tests
const mockExecSync = mockExecFileSync;

import {
  generateApiDoc,
  generateFeatureDoc,
  generateReleaseNotes,
  saveDocument,
  getDocuments,
  downloadDocument,
  parseTypeScriptFunctions,
  parsePythonFunctions,
} from "@/lib/doc-generator";

function setDatabaseUrl(val: string | undefined) {
  if (val === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = val;
  }
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => delete process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// parseTypeScriptFunctions
// ---------------------------------------------------------------------------
describe("parseTypeScriptFunctions", () => {
  test("parses exported functions with params and return types", () => {
    const code = `
/**
 * Authenticate a user by email + password.
 */
export async function authenticate(email: string, password: string): Promise<AuthResult | null> {
  return null;
}

function internalHelper(x: number): boolean {
  return true;
}

export const myConst = async (a: string) => {};
`;
    const fns = parseTypeScriptFunctions(code);

    expect(fns).toHaveLength(3);

    const auth = fns.find((f) => f.name === "authenticate");
    expect(auth).toBeDefined();
    expect(auth!.exported).toBe(true);
    expect(auth!.params).toEqual(["email: string", "password: string"]);
    expect(auth!.returnType).toContain("Promise");
    expect(auth!.jsdoc).toContain("Authenticate");

    const helper = fns.find((f) => f.name === "internalHelper");
    expect(helper).toBeDefined();
    expect(helper!.exported).toBe(false);

    const arrow = fns.find((f) => f.name === "myConst");
    expect(arrow).toBeDefined();
    expect(arrow!.exported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parsePythonFunctions
// ---------------------------------------------------------------------------
describe("parsePythonFunctions", () => {
  test("parses Python functions with docstrings and type hints", () => {
    const code = `
def public_func(name: str, count: int) -> list:
    """Return a list of names."""
    return [name] * count

def _private_func(x):
    return x

class MyClass:
    def method(self) -> None:
        pass
`;
    const fns = parsePythonFunctions(code);

    expect(fns.length).toBeGreaterThanOrEqual(2);

    const pub = fns.find((f) => f.name === "public_func");
    expect(pub).toBeDefined();
    expect(pub!.exported).toBe(true);
    expect(pub!.params).toEqual(["name: str", "count: int"]);
    expect(pub!.returnType).toBe("list");
    expect(pub!.jsdoc).toContain("Return a list");

    const priv = fns.find((f) => f.name === "_private_func");
    expect(priv).toBeDefined();
    expect(priv!.exported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateApiDoc
// ---------------------------------------------------------------------------
describe("generateApiDoc", () => {
  test("generates markdown from TypeScript file (zero tokens)", () => {
    mockReadFileSync.mockReturnValue(`
/**
 * Track an event.
 */
export function trackEvent(event: string, userId: string): void {
  // ...
}
`);

    const doc = generateApiDoc("/repo", "src/lib/analytics.ts");

    expect(doc.doc_type).toBe("api_doc");
    expect(doc.tokens_used).toBe(0);
    expect(doc.content).toContain("# API Documentation");
    expect(doc.content).toContain("trackEvent");
    expect(doc.content).toContain("Exported Functions");
    expect(doc.content).toContain("TypeScript");
  });

  test("handles missing file gracefully", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const doc = generateApiDoc("/repo", "missing.ts");

    expect(doc.content).toContain("File not found");
    expect(doc.tokens_used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateReleaseNotes
// ---------------------------------------------------------------------------
describe("generateReleaseNotes", () => {
  test("groups commits by type (zero tokens)", () => {
    mockExecSync.mockReturnValue(
      [
        "abc1234|feat: add knowledge base|Dev User|2026-04-01 10:00:00 +0000",
        "def5678|fix: resolve auth bug|Dev User|2026-04-02 10:00:00 +0000",
        "ghi9012|docs: update README|Dev User|2026-04-03 10:00:00 +0000",
        "jkl3456|chore: bump deps|Dev User|2026-04-03 12:00:00 +0000",
      ].join("\n"),
    );

    const doc = generateReleaseNotes("/repo", "2026-04-01");

    expect(doc.doc_type).toBe("release_notes");
    expect(doc.tokens_used).toBe(0);
    expect(doc.content).toContain("New Features (1)");
    expect(doc.content).toContain("Bug Fixes (1)");
    expect(doc.content).toContain("Documentation (1)");
    expect(doc.content).toContain("Chores (1)");
    expect(doc.content).toContain("Total commits**: 4");
  });

  test("handles git failure gracefully", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const doc = generateReleaseNotes("/bad-repo", "2026-01-01");

    expect(doc.content).toContain("Unable to read git log");
    expect(doc.tokens_used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateFeatureDoc
// ---------------------------------------------------------------------------
describe("generateFeatureDoc", () => {
  test("generates structured doc from DB record", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "f-1",
          title: "Auto-deploy pipeline",
          description: "Build a CI/CD pipeline that auto-deploys on merge.",
          submitted_by: "u1",
          status: "approved",
          priority: "high",
          target_product: "wolfpack-apex",
          analysis: { complexity: "medium", viability: "high" },
          estimated_hours: 40,
          estimated_cost: 6000,
          votes: 5,
          created_at: "2026-04-01",
          updated_at: "2026-04-03",
        },
      ],
    });

    const doc = await generateFeatureDoc("f-1");

    expect(doc.doc_type).toBe("feature_doc");
    expect(doc.tokens_used).toBe(0);
    expect(doc.content).toContain("Auto-deploy pipeline");
    expect(doc.content).toContain("approved");
    expect(doc.content).toContain("$6,000");
    expect(doc.content).toContain("40");
  });

  test("shadow mode returns demo feature doc", async () => {
    setDatabaseUrl(undefined);

    const doc = await generateFeatureDoc("demo-f1");

    expect(doc.doc_type).toBe("feature_doc");
    expect(doc.tokens_used).toBe(0);
    expect(doc.content).toContain("Demo Feature");
  });
});

// ---------------------------------------------------------------------------
// saveDocument
// ---------------------------------------------------------------------------
describe("saveDocument", () => {
  test("inserts and tracks event", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "d-1",
          title: "Test Doc",
          doc_type: "api_doc",
          content: "# Test",
          format: "markdown",
          generated_from: "test.ts",
          generated_by: "u1",
          revision: 1,
          tokens_used: 0,
          downloads: 0,
          created_at: "2026-04-04",
          updated_at: "2026-04-04",
        },
      ],
    });

    const doc = await saveDocument(
      {
        title: "Test Doc",
        doc_type: "api_doc",
        content: "# Test",
        format: "markdown",
        generated_from: "test.ts",
        generated_by: "u1",
        tokens_used: 0,
      },
      "u1",
    );

    expect(doc).not.toBeNull();
    expect(doc!.id).toBe("d-1");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.doc_generated",
      "u1",
      "dev",
      expect.objectContaining({ doc_type: "api_doc", tokens_used: 0 }),
    );
  });

  test("shadow mode returns demo doc", async () => {
    setDatabaseUrl(undefined);

    const doc = await saveDocument(
      {
        title: "Shadow Doc",
        doc_type: "api_doc",
        content: "# Shadow",
        format: "markdown",
        generated_from: null,
        generated_by: "u1",
        tokens_used: 0,
      },
      "u1",
    );

    expect(doc).not.toBeNull();
    expect(doc!.id).toMatch(/^demo-/);
  });
});

// ---------------------------------------------------------------------------
// getDocuments
// ---------------------------------------------------------------------------
describe("getDocuments", () => {
  test("returns filtered results", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "d-1",
          title: "Doc",
          doc_type: "api_doc",
          content: "#",
          format: "markdown",
          generated_from: null,
          generated_by: "u1",
          revision: 1,
          tokens_used: 0,
          downloads: 0,
          created_at: "2026-04-04",
          updated_at: "2026-04-04",
        },
      ],
      fromCache: false,
    });

    const docs = await getDocuments("u1", "api_doc");

    expect(docs).toHaveLength(1);
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("generated_by"),
      ["u1", "api_doc"],
    );
  });

  test("shadow mode returns demo docs", async () => {
    setDatabaseUrl(undefined);

    const docs = await getDocuments();
    expect(docs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// downloadDocument
// ---------------------------------------------------------------------------
describe("downloadDocument", () => {
  test("increments download count and tracks event", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "d-1",
          title: "Doc",
          doc_type: "api_doc",
          content: "#",
          format: "markdown",
          generated_from: null,
          generated_by: "u1",
          revision: 1,
          tokens_used: 0,
          downloads: 4,
          created_at: "2026-04-04",
          updated_at: "2026-04-04",
        },
      ],
    });

    const doc = await downloadDocument("d-1", "u1");

    expect(doc).not.toBeNull();
    expect(doc!.downloads).toBe(4);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("downloads = downloads + 1"),
      ["d-1"],
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.doc_downloaded",
      "u1",
      "dev",
      expect.objectContaining({ doc_id: "d-1" }),
    );
  });

  test("returns null for missing doc", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const doc = await downloadDocument("nonexistent", "u1");
    expect(doc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Zero tokens verification
// ---------------------------------------------------------------------------
describe("zero-token verification", () => {
  test("all generated docs have tokens_used=0", () => {
    mockReadFileSync.mockReturnValue("export function hello(): void {}");
    mockExecSync.mockReturnValue("abc|feat: test|Dev|2026-04-01");

    const apiDoc = generateApiDoc("/repo", "test.ts");
    const releaseDoc = generateReleaseNotes("/repo", "2026-04-01");

    expect(apiDoc.tokens_used).toBe(0);
    expect(releaseDoc.tokens_used).toBe(0);
  });
});

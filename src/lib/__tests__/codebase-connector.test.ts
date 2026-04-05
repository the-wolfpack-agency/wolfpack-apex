/**
 * Codebase Connector Tests
 *
 * Tests filesystem walking, search, stats, explain, path traversal prevention,
 * and analytics tracking.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { trackEvent } from "@/lib/analytics";

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import {
  getRepoStructure,
  getFileContent,
  searchCodebase,
  getCodebaseStats,
  explainFile,
  validatePath,
} from "@/lib/codebase-connector";

// ---------------------------------------------------------------------------
// Test fixture: create a temp repo
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-codebase-test-"));

  // Create structure
  fs.mkdirSync(path.join(tmpDir, "src", "app", "api", "users"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "src", "lib", "__tests__"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "node_modules", "react"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "migrations"), { recursive: true });

  // Files
  fs.writeFileSync(
    path.join(tmpDir, "src", "lib", "auth.ts"),
    `import { sign } from "jsonwebtoken";
import { query } from "@/lib/db";

export interface AuthResult {
  user: string;
  token: string;
}

/**
 * Authenticate a user by email and password.
 */
export async function authenticate(email: string, password: string): Promise<AuthResult | null> {
  return null;
}

export function hashPassword(pw: string): string {
  return pw;
}
`,
  );

  fs.writeFileSync(
    path.join(tmpDir, "src", "app", "api", "users", "route.ts"),
    `export async function GET() { return new Response("ok"); }\n`,
  );

  fs.writeFileSync(
    path.join(tmpDir, "src", "lib", "__tests__", "auth.test.ts"),
    `test("auth works", () => { expect(true).toBe(true); });\n`,
  );

  fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name": "test-repo"}\n');
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Repo\n\nThis is a test.\n");

  fs.writeFileSync(path.join(tmpDir, "migrations", "001_init.sql"), "CREATE TABLE users (id TEXT);\n");

  // node_modules file (should be skipped)
  fs.writeFileSync(path.join(tmpDir, "node_modules", "react", "index.js"), "module.exports = {};");

  // .git file (should be skipped)
  fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getRepoStructure
// ---------------------------------------------------------------------------

describe("getRepoStructure", () => {
  test("returns files, skips node_modules and .git", () => {
    const entries = getRepoStructure(tmpDir);
    const paths = entries.map((e) => e.path);

    expect(entries.length).toBeGreaterThan(0);
    expect(paths).toContain(path.join("src", "lib", "auth.ts"));
    expect(paths).toContain("package.json");
    expect(paths).toContain("README.md");

    // Must NOT include node_modules or .git
    for (const p of paths) {
      expect(p).not.toContain("node_modules");
      expect(p).not.toContain(".git");
    }
  });

  test("each entry has required fields", () => {
    const entries = getRepoStructure(tmpDir);
    for (const entry of entries) {
      expect(entry).toHaveProperty("path");
      expect(entry).toHaveProperty("type");
      expect(entry).toHaveProperty("size");
      expect(entry).toHaveProperty("lastModified");
      expect(typeof entry.size).toBe("number");
    }
  });

  test("tracks analytics", () => {
    getRepoStructure(tmpDir, "u1", "dev");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.codebase_searched",
      "u1",
      "dev",
      expect.objectContaining({ action: "structure" }),
    );
  });

  test("throws on nonexistent path", () => {
    expect(() => getRepoStructure("/nonexistent/repo")).toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// getFileContent
// ---------------------------------------------------------------------------

describe("getFileContent", () => {
  test("reads file correctly", () => {
    const content = getFileContent(tmpDir, "package.json");
    expect(content).toContain('"name": "test-repo"');
  });

  test("rejects path traversal (../../etc/passwd)", () => {
    expect(() => getFileContent(tmpDir, "../../etc/passwd")).toThrow("Path traversal");
  });

  test("rejects absolute path outside repo", () => {
    expect(() => getFileContent(tmpDir, "/etc/passwd")).toThrow();
  });

  test("throws on nonexistent file", () => {
    expect(() => getFileContent(tmpDir, "does-not-exist.ts")).toThrow("not found");
  });

  test("tracks analytics", () => {
    getFileContent(tmpDir, "README.md", "u2", "sales");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.codebase_searched",
      "u2",
      "sales",
      expect.objectContaining({ action: "file_read", file: "README.md" }),
    );
  });
});

// ---------------------------------------------------------------------------
// validatePath
// ---------------------------------------------------------------------------

describe("validatePath", () => {
  test("allows valid relative paths", () => {
    const result = validatePath(tmpDir, "src/lib/auth.ts");
    expect(result).toBe(path.resolve(tmpDir, "src/lib/auth.ts"));
  });

  test("rejects traversal attempts", () => {
    expect(() => validatePath(tmpDir, "../../../etc/shadow")).toThrow("Path traversal");
    expect(() => validatePath(tmpDir, "src/../../etc/passwd")).toThrow("Path traversal");
  });
});

// ---------------------------------------------------------------------------
// searchCodebase
// ---------------------------------------------------------------------------

describe("searchCodebase", () => {
  test("finds matches with line numbers", () => {
    const results = searchCodebase(tmpDir, "authenticate");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("file");
    expect(results[0]).toHaveProperty("line");
    expect(results[0]).toHaveProperty("content");
    expect(results[0].line).toBeGreaterThan(0);
  });

  test("returns empty for no matches", () => {
    const results = searchCodebase(tmpDir, "zzz_nonexistent_pattern_zzz");
    expect(results).toEqual([]);
  });

  test("respects fileTypes filter", () => {
    const results = searchCodebase(tmpDir, "test", "system", "dev", ["md"]);
    for (const r of results) {
      expect(r.file).toMatch(/\.md$/);
    }
  });

  test("limits to 50 results", () => {
    // Even searching for common chars, should not exceed 50
    const results = searchCodebase(tmpDir, "e");
    expect(results.length).toBeLessThanOrEqual(50);
  });

  test("tracks analytics", () => {
    searchCodebase(tmpDir, "query", "u3", "cto");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.codebase_searched",
      "u3",
      "cto",
      expect.objectContaining({ action: "search", query: "query" }),
    );
  });
});

// ---------------------------------------------------------------------------
// getCodebaseStats
// ---------------------------------------------------------------------------

describe("getCodebaseStats", () => {
  test("counts files by language", () => {
    const stats = getCodebaseStats(tmpDir);
    expect(stats.totalFiles).toBeGreaterThan(0);
    expect(stats.linesByLanguage["TypeScript"]).toBeGreaterThan(0);
    expect(stats.linesByLanguage["JSON"]).toBeGreaterThan(0);
  });

  test("counts API routes", () => {
    const stats = getCodebaseStats(tmpDir);
    expect(stats.apiRoutes).toBe(1);
  });

  test("counts test files", () => {
    const stats = getCodebaseStats(tmpDir);
    expect(stats.tests).toBe(1);
  });

  test("counts migration files", () => {
    const stats = getCodebaseStats(tmpDir);
    expect(stats.migrations).toBe(1);
  });

  test("tracks analytics", () => {
    getCodebaseStats(tmpDir, "u4", "ops");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.codebase_searched",
      "u4",
      "ops",
      expect.objectContaining({ action: "stats" }),
    );
  });
});

// ---------------------------------------------------------------------------
// explainFile
// ---------------------------------------------------------------------------

describe("explainFile", () => {
  test("parses TypeScript imports", () => {
    const explanation = explainFile(tmpDir, "src/lib/auth.ts");
    expect(explanation.imports).toContain("jsonwebtoken");
    expect(explanation.imports).toContain("@/lib/db");
  });

  test("parses TypeScript exports", () => {
    const explanation = explainFile(tmpDir, "src/lib/auth.ts");
    expect(explanation.exports).toContain("AuthResult");
    expect(explanation.exports).toContain("authenticate");
    expect(explanation.exports).toContain("hashPassword");
  });

  test("parses function signatures", () => {
    const explanation = explainFile(tmpDir, "src/lib/auth.ts");
    const authFn = explanation.functions.find((f) => f.name === "authenticate");
    expect(authFn).toBeDefined();
    expect(authFn!.params).toContain("email");
    expect(authFn!.params).toContain("password");
  });

  test("generates summary", () => {
    const explanation = explainFile(tmpDir, "src/lib/auth.ts");
    expect(explanation.summary).toContain("TypeScript module");
    expect(explanation.summary).toContain("imports");
    expect(explanation.summary).toContain("exports");
  });

  test("throws on nonexistent file", () => {
    expect(() => explainFile(tmpDir, "nonexistent.ts")).toThrow("not found");
  });

  test("tracks analytics", () => {
    explainFile(tmpDir, "src/lib/auth.ts", "u5", "dev");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.codebase_searched",
      "u5",
      "dev",
      expect.objectContaining({ action: "explain", file: "src/lib/auth.ts" }),
    );
  });
});

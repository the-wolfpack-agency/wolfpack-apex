/**
 * Codebase Connector — Let non-technical team members query the wolfpack-auto
 * codebase without touching code.
 *
 * Zero-token-first: all analysis is computed from the filesystem, no AI calls.
 * Every call tracks analytics for the learning loop.
 */

import * as fs from "fs";
import * as path from "path";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  type: string;
  size: number;
  lastModified: string;
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

export interface CodebaseStats {
  totalFiles: number;
  linesByLanguage: Record<string, number>;
  apiRoutes: number;
  tests: number;
  migrations: number;
}

export interface FileExplanation {
  filePath: string;
  imports: string[];
  exports: string[];
  functions: { name: string; params: string; returnType: string; description: string }[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  ".turbo",
  "coverage",
  ".vercel",
  "__pycache__",
]);

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (JSX)",
  ".js": "JavaScript",
  ".jsx": "JavaScript (JSX)",
  ".py": "Python",
  ".sql": "SQL",
  ".json": "JSON",
  ".md": "Markdown",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".sh": "Shell",
  ".go": "Go",
  ".rs": "Rust",
};

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/**
 * Validate that a file path does not escape the repo root.
 * Throws on path traversal attempts.
 */
export function validatePath(repoPath: string, filePath: string): string {
  const resolvedRepo = path.resolve(repoPath);
  const resolvedFile = path.resolve(repoPath, filePath);
  if (!resolvedFile.startsWith(resolvedRepo + path.sep) && resolvedFile !== resolvedRepo) {
    throw new Error("Path traversal detected — access denied");
  }
  return resolvedFile;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Walk directory, return tree of files with types. Skips node_modules, .next, .git, dist.
 */
export function getRepoStructure(
  repoPath: string,
  userId: string = "system",
  userRole: string = "dev",
): FileEntry[] {
  const resolvedRoot = path.resolve(repoPath);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Repository path not found: ${resolvedRoot}`);
  }

  const entries: FileEntry[] = [];

  function walk(dir: string) {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;

      const fullPath = path.join(dir, item.name);
      const relativePath = path.relative(resolvedRoot, fullPath);

      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const ext = path.extname(item.name).toLowerCase();
          entries.push({
            path: relativePath,
            type: ext.replace(".", "") || "unknown",
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(resolvedRoot);

  trackEvent("knowledge.codebase_searched", userId, userRole, {
    action: "structure",
    repo: repoPath,
    file_count: entries.length,
  });

  return entries;
}

/**
 * Read a file and return its contents. Validates path against repo root.
 */
export function getFileContent(
  repoPath: string,
  filePath: string,
  userId: string = "system",
  userRole: string = "dev",
): string {
  const resolved = validatePath(repoPath, filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  // Limit file size to 1MB
  if (stat.size > 1_048_576) {
    throw new Error(`File too large (${(stat.size / 1024).toFixed(0)}KB). Max 1MB.`);
  }

  const content = fs.readFileSync(resolved, "utf-8");

  trackEvent("knowledge.codebase_searched", userId, userRole, {
    action: "file_read",
    repo: repoPath,
    file: filePath,
    size: stat.size,
  });

  return content;
}

/**
 * Grep-style search across the repo. Returns up to 50 results with line numbers.
 */
export function searchCodebase(
  repoPath: string,
  query: string,
  userId: string = "system",
  userRole: string = "dev",
  fileTypes?: string[],
): SearchResult[] {
  const resolvedRoot = path.resolve(repoPath);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Repository path not found: ${resolvedRoot}`);
  }

  if (!query || typeof query !== "string") {
    throw new Error("Search query is required");
  }

  const results: SearchResult[] = [];
  const MAX_RESULTS = 50;
  const queryLower = query.toLowerCase();

  function searchFile(fullPath: string, relativePath: string) {
    if (results.length >= MAX_RESULTS) return;

    try {
      const stat = fs.statSync(fullPath);
      // Skip files larger than 512KB for search
      if (stat.size > 524_288) return;

      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_RESULTS) return;
        if (lines[i].toLowerCase().includes(queryLower)) {
          results.push({
            file: relativePath,
            line: i + 1,
            content: lines[i].trimEnd().substring(0, 200),
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  function walk(dir: string) {
    if (results.length >= MAX_RESULTS) return;

    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (results.length >= MAX_RESULTS) return;
      if (SKIP_DIRS.has(item.name)) continue;

      const fullPath = path.join(dir, item.name);
      const relativePath = path.relative(resolvedRoot, fullPath);

      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        if (fileTypes && fileTypes.length > 0) {
          if (!fileTypes.includes(ext.replace(".", ""))) continue;
        }
        searchFile(fullPath, relativePath);
      }
    }
  }

  walk(resolvedRoot);

  trackEvent("knowledge.codebase_searched", userId, userRole, {
    action: "search",
    repo: repoPath,
    query,
    result_count: results.length,
  });

  return results;
}

/**
 * Compute codebase stats: files, lines by language, routes, tests, migrations.
 */
export function getCodebaseStats(
  repoPath: string,
  userId: string = "system",
  userRole: string = "dev",
): CodebaseStats {
  const resolvedRoot = path.resolve(repoPath);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Repository path not found: ${resolvedRoot}`);
  }

  const stats: CodebaseStats = {
    totalFiles: 0,
    linesByLanguage: {},
    apiRoutes: 0,
    tests: 0,
    migrations: 0,
  };

  function walk(dir: string) {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (SKIP_DIRS.has(item.name)) continue;

      const fullPath = path.join(dir, item.name);
      const relativePath = path.relative(resolvedRoot, fullPath);

      if (item.isDirectory()) {
        // Count API routes (Next.js convention)
        if (relativePath.includes("api") && item.name === "route.ts") {
          // handled below in file check
        }
        walk(fullPath);
      } else if (item.isFile()) {
        stats.totalFiles++;

        const ext = path.extname(item.name).toLowerCase();
        const lang = EXT_TO_LANG[ext];

        if (lang) {
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const lineCount = content.split("\n").length;
            stats.linesByLanguage[lang] = (stats.linesByLanguage[lang] || 0) + lineCount;
          } catch {
            // Skip unreadable files
          }
        }

        // Count API routes
        if (item.name === "route.ts" && relativePath.includes("api")) {
          stats.apiRoutes++;
        }

        // Count test files
        if (
          item.name.includes(".test.") ||
          item.name.includes(".spec.") ||
          relativePath.includes("__tests__")
        ) {
          stats.tests++;
        }

        // Count migration files
        if (relativePath.includes("migration") || relativePath.includes("migrations")) {
          stats.migrations++;
        }
      }
    }
  }

  walk(resolvedRoot);

  trackEvent("knowledge.codebase_searched", userId, userRole, {
    action: "stats",
    repo: repoPath,
    total_files: stats.totalFiles,
  });

  return stats;
}

/**
 * Parse a TypeScript file and generate a plain-English summary.
 * ZERO TOKEN — pure code analysis, no AI.
 */
export function explainFile(
  repoPath: string,
  filePath: string,
  userId: string = "system",
  userRole: string = "dev",
): FileExplanation {
  const resolved = validatePath(repoPath, filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split("\n");

  // Parse imports
  const imports: string[] = [];
  for (const line of lines) {
    const importMatch = line.match(/^import\s+.*?\s+from\s+["'](.+?)["']/);
    if (importMatch) {
      imports.push(importMatch[1]);
    }
    const requireMatch = line.match(/require\(["'](.+?)["']\)/);
    if (requireMatch) {
      imports.push(requireMatch[1]);
    }
  }

  // Parse exports
  const exports: string[] = [];
  for (const line of lines) {
    const namedExport = line.match(/^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/);
    if (namedExport) {
      exports.push(namedExport[1]);
    }
    const defaultExport = line.match(/^export\s+default\s+(?:function\s+)?(\w+)?/);
    if (defaultExport && defaultExport[1]) {
      exports.push(`default: ${defaultExport[1]}`);
    }
  }

  // Parse functions with signatures
  const functions: FileExplanation["functions"] = [];
  for (let i = 0; i < lines.length; i++) {
    const fnMatch = lines[i].match(
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/,
    );
    if (fnMatch) {
      // Look for a JSDoc comment above
      let description = "";
      if (i > 0) {
        let j = i - 1;
        while (j >= 0 && lines[j].trim().startsWith("*") || lines[j].trim().startsWith("/**") || lines[j].trim().startsWith("//")) {
          const cleaned = lines[j].trim().replace(/^\/\*\*\s*/, "").replace(/^\*\/?\s*/, "").replace(/^\/\/\s*/, "").trim();
          if (cleaned && !cleaned.startsWith("@")) {
            description = cleaned + (description ? " " + description : "");
          }
          j--;
        }
      }

      functions.push({
        name: fnMatch[1],
        params: fnMatch[2].trim(),
        returnType: fnMatch[3] || "void",
        description: description || `Function ${fnMatch[1]}`,
      });
    }

    // Arrow function exports
    const arrowMatch = lines[i].match(
      /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)(?:\s*:\s*([^\s=]+))?\s*=>/,
    );
    if (arrowMatch) {
      functions.push({
        name: arrowMatch[1],
        params: arrowMatch[2].trim(),
        returnType: arrowMatch[3] || "inferred",
        description: `Arrow function ${arrowMatch[1]}`,
      });
    }
  }

  // Build summary
  const ext = path.extname(filePath);
  const summaryParts: string[] = [];
  summaryParts.push(`This ${ext === ".tsx" ? "React component" : "TypeScript module"} file`);
  if (imports.length > 0) {
    summaryParts.push(`imports from ${imports.length} module(s)`);
  }
  if (exports.length > 0) {
    summaryParts.push(`exports ${exports.length} item(s): ${exports.join(", ")}`);
  }
  if (functions.length > 0) {
    summaryParts.push(`defines ${functions.length} function(s)`);
  }
  summaryParts.push(`and is ${lines.length} lines long`);

  const summary = summaryParts.join(", ") + ".";

  trackEvent("knowledge.codebase_searched", userId, userRole, {
    action: "explain",
    repo: repoPath,
    file: filePath,
    exports_count: exports.length,
    functions_count: functions.length,
  });

  return { filePath, imports, exports, functions, summary };
}

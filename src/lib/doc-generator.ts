/**
 * Document Generation — Zero-token-first.
 *
 * All document generation is done by parsing source files, git logs,
 * and database records. No AI calls. Every generated doc tracks
 * tokens_used=0 to prove zero-token operation.
 */

import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface GeneratedDocument {
  id: string;
  title: string;
  doc_type: string;
  content: string;
  format: string;
  generated_from: string | null;
  generated_by: string;
  revision: number;
  tokens_used: number;
  downloads: number;
  created_at: string;
  updated_at: string;
}

export interface FunctionSignature {
  name: string;
  params: string[];
  returnType: string;
  jsdoc: string;
  exported: boolean;
}

// ---------------------------------------------------------------------------
// Shadow mode demo data
// ---------------------------------------------------------------------------
const DEMO_DOCS: GeneratedDocument[] = [
  {
    id: "demo-d1",
    title: "API Documentation - auth.ts",
    doc_type: "api_doc",
    content: "# Auth API\n\nJWT-based authentication for Wolfpack Apex.",
    format: "markdown",
    generated_from: "src/lib/auth.ts",
    generated_by: "demo-cto",
    revision: 1,
    tokens_used: 0,
    downloads: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// ---------------------------------------------------------------------------
// generateApiDoc — Parse TS/Python and generate markdown docs (zero tokens)
// ---------------------------------------------------------------------------
export function generateApiDoc(repoPath: string, filePath: string): GeneratedDocument {
  const fullPath = `${repoPath}/${filePath}`;
  let fileContent: string;

  try {
    fileContent = readFileSync(fullPath, "utf-8");
  } catch {
    return makeDoc({
      title: `API Documentation - ${filePath}`,
      doc_type: "api_doc",
      content: `# ${filePath}\n\nFile not found at \`${fullPath}\`.`,
      generated_from: filePath,
    });
  }

  const isTypeScript = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
  const isPython = filePath.endsWith(".py");

  let signatures: FunctionSignature[];
  if (isPython) {
    signatures = parsePythonFunctions(fileContent);
  } else {
    signatures = parseTypeScriptFunctions(fileContent);
  }

  const exports = signatures.filter((s) => s.exported);
  const internal = signatures.filter((s) => !s.exported);

  let md = `# API Documentation: ${filePath}\n\n`;
  md += `**Language**: ${isTypeScript ? "TypeScript" : isPython ? "Python" : "Unknown"}\n`;
  md += `**Exports**: ${exports.length} | **Internal**: ${internal.length}\n`;
  md += `**Generated**: ${new Date().toISOString()} (zero tokens)\n\n`;

  if (exports.length > 0) {
    md += `## Exported Functions\n\n`;
    for (const fn of exports) {
      md += formatFunctionDoc(fn);
    }
  }

  if (internal.length > 0) {
    md += `## Internal Functions\n\n`;
    for (const fn of internal) {
      md += formatFunctionDoc(fn);
    }
  }

  return makeDoc({
    title: `API Documentation - ${filePath}`,
    doc_type: "api_doc",
    content: md,
    generated_from: filePath,
  });
}

// ---------------------------------------------------------------------------
// generateFeatureDoc — From DB feature request (zero tokens)
// ---------------------------------------------------------------------------
export async function generateFeatureDoc(
  featureRequestId: string,
): Promise<GeneratedDocument> {
  if (!process.env.DATABASE_URL) {
    return makeDoc({
      title: "Feature: Demo Feature Request",
      doc_type: "feature_doc",
      content: "# Feature: Demo Feature\n\n**Status**: submitted\n\n## Description\n\nDemo feature request in shadow mode.",
      generated_from: featureRequestId,
    });
  }

  try {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM apex_feature_requests WHERE id = $1`,
      [featureRequestId],
    );

    if (result.rows.length === 0) {
      return makeDoc({
        title: "Feature Not Found",
        doc_type: "feature_doc",
        content: `# Feature Request Not Found\n\nID: ${featureRequestId}`,
        generated_from: featureRequestId,
      });
    }

    const f = result.rows[0];
    const analysis = (f.analysis as Record<string, unknown>) ?? {};

    let md = `# Feature: ${f.title}\n\n`;
    md += `**Status**: ${f.status}\n`;
    md += `**Priority**: ${f.priority}\n`;
    md += `**Submitted by**: ${f.submitted_by}\n`;
    md += `**Target product**: ${f.target_product ?? "Unspecified"}\n\n`;
    md += `## Description\n\n${f.description}\n\n`;

    if (Object.keys(analysis).length > 0) {
      md += `## Analysis\n\n`;
      for (const [key, val] of Object.entries(analysis)) {
        md += `- **${key}**: ${JSON.stringify(val)}\n`;
      }
      md += "\n";
    }

    if (f.estimated_hours || f.estimated_cost) {
      md += `## Cost Estimate\n\n`;
      if (f.estimated_hours) md += `- **Hours**: ${f.estimated_hours}\n`;
      if (f.estimated_cost) md += `- **Cost**: $${Number(f.estimated_cost).toLocaleString()}\n`;
      md += "\n";
    }

    md += `## Timeline\n\n`;
    md += `- **Created**: ${f.created_at}\n`;
    md += `- **Last updated**: ${f.updated_at}\n`;
    md += `- **Votes**: ${f.votes}\n`;

    return makeDoc({
      title: `Feature: ${f.title as string}`,
      doc_type: "feature_doc",
      content: md,
      generated_from: featureRequestId,
    });
  } catch (err) {
    console.error("[doc-gen] generateFeatureDoc error:", (err as Error).message);
    return makeDoc({
      title: "Feature Doc Error",
      doc_type: "feature_doc",
      content: `# Error\n\nFailed to generate feature doc: ${(err as Error).message}`,
      generated_from: featureRequestId,
    });
  }
}

// ---------------------------------------------------------------------------
// generateReleaseNotes — Parse git log (zero tokens)
// ---------------------------------------------------------------------------
export function generateReleaseNotes(repoPath: string, sinceDate: string): GeneratedDocument {
  // Input validation to prevent command injection (CWE-78)
  if (!/^[a-zA-Z0-9\/_.-]+$/.test(repoPath) || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    return makeDoc({
      title: `Release Notes since ${sinceDate}`,
      doc_type: "release_notes",
      content: `# Release Notes\n\nInvalid repository path or date format.`,
      generated_from: repoPath,
    });
  }

  let gitLog: string;

  try {
    gitLog = execFileSync(
      "git",
      ["-C", repoPath, "log", "--since=" + sinceDate, "--pretty=format:%h|%s|%an|%ai", "--no-merges"],
      { encoding: "utf-8", timeout: 10000 },
    );
  } catch {
    return makeDoc({
      title: `Release Notes since ${sinceDate}`,
      doc_type: "release_notes",
      content: `# Release Notes\n\nUnable to read git log from \`${repoPath}\`.`,
      generated_from: repoPath,
    });
  }

  const lines = gitLog.trim().split("\n").filter(Boolean);
  const groups: Record<string, { hash: string; message: string; author: string; date: string }[]> = {
    feat: [],
    fix: [],
    docs: [],
    refactor: [],
    test: [],
    chore: [],
    other: [],
  };

  for (const line of lines) {
    const [hash, message, author, date] = line.split("|");
    const type = categorizeCommit(message);
    groups[type].push({ hash, message, author, date });
  }

  let md = `# Release Notes\n\n`;
  md += `**Period**: ${sinceDate} to ${new Date().toISOString().slice(0, 10)}\n`;
  md += `**Total commits**: ${lines.length}\n`;
  md += `**Generated**: ${new Date().toISOString()} (zero tokens)\n\n`;

  const labels: Record<string, string> = {
    feat: "New Features",
    fix: "Bug Fixes",
    docs: "Documentation",
    refactor: "Refactoring",
    test: "Tests",
    chore: "Chores",
    other: "Other Changes",
  };

  for (const [type, commits] of Object.entries(groups)) {
    if (commits.length === 0) continue;
    md += `## ${labels[type]} (${commits.length})\n\n`;
    for (const c of commits) {
      md += `- \`${c.hash}\` ${c.message} — *${c.author}*\n`;
    }
    md += "\n";
  }

  return makeDoc({
    title: `Release Notes since ${sinceDate}`,
    doc_type: "release_notes",
    content: md,
    generated_from: repoPath,
  });
}

// ---------------------------------------------------------------------------
// saveDocument — INSERT into apex_documents
// ---------------------------------------------------------------------------
export async function saveDocument(
  doc: Omit<GeneratedDocument, "id" | "revision" | "downloads" | "created_at" | "updated_at">,
  userId: string,
): Promise<GeneratedDocument | null> {
  trackEvent("knowledge.doc_generated", userId, "dev", {
    doc_type: doc.doc_type,
    tokens_used: doc.tokens_used,
  });

  if (!process.env.DATABASE_URL) {
    return {
      ...doc,
      id: `demo-${Date.now()}`,
      revision: 1,
      downloads: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  try {
    const result = await query<Record<string, unknown>>(
      `INSERT INTO apex_documents (title, doc_type, content, format, generated_from, generated_by, tokens_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [doc.title, doc.doc_type, doc.content, doc.format, doc.generated_from, doc.generated_by, doc.tokens_used],
    );
    return rowToDocument(result.rows[0]);
  } catch (err) {
    console.error("[doc-gen] saveDocument error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// getDocuments — SELECT with filters
// ---------------------------------------------------------------------------
export async function getDocuments(
  userId?: string,
  docType?: string,
): Promise<GeneratedDocument[]> {
  if (!process.env.DATABASE_URL) return DEMO_DOCS;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (userId) {
    conditions.push(`generated_by = $${idx++}`);
    params.push(userId);
  }
  if (docType) {
    conditions.push(`doc_type = $${idx++}`);
    params.push(docType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM apex_documents ${where} ORDER BY created_at DESC LIMIT 50`,
    params,
  );
  return rows.map(rowToDocument);
}

// ---------------------------------------------------------------------------
// downloadDocument — Increment download count
// ---------------------------------------------------------------------------
export async function downloadDocument(
  docId: string,
  userId: string,
): Promise<GeneratedDocument | null> {
  trackEvent("knowledge.doc_downloaded", userId, "dev", { doc_id: docId });

  if (!process.env.DATABASE_URL) {
    return DEMO_DOCS.find((d) => d.id === docId) ?? null;
  }

  try {
    const result = await query<Record<string, unknown>>(
      `UPDATE apex_documents SET downloads = downloads + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [docId],
    );
    return result.rows.length > 0 ? rowToDocument(result.rows[0]) : null;
  } catch (err) {
    console.error("[doc-gen] downloadDocument error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsers (zero-token)
// ---------------------------------------------------------------------------
export function parseTypeScriptFunctions(content: string): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const lines = content.split("\n");
  let currentJsdoc = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Collect JSDoc
    if (line.trimStart().startsWith("/**")) {
      currentJsdoc = "";
      let j = i;
      while (j < lines.length) {
        currentJsdoc += lines[j] + "\n";
        if (lines[j].includes("*/")) break;
        j++;
      }
      continue;
    }

    // Match function declarations
    const fnMatch = line.match(
      /^(export\s+)?(async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^\s{]+))?/,
    );
    if (fnMatch) {
      signatures.push({
        name: fnMatch[3],
        params: fnMatch[4]
          ? fnMatch[4].split(",").map((p) => p.trim()).filter(Boolean)
          : [],
        returnType: fnMatch[5] ?? "void",
        jsdoc: currentJsdoc.trim(),
        exported: !!fnMatch[1],
      });
      currentJsdoc = "";
      continue;
    }

    // Match arrow function exports
    const arrowMatch = line.match(
      /^(export\s+)?(const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
    );
    if (arrowMatch) {
      signatures.push({
        name: arrowMatch[3],
        params: [],
        returnType: "unknown",
        jsdoc: currentJsdoc.trim(),
        exported: !!arrowMatch[1],
      });
      currentJsdoc = "";
      continue;
    }

    // Reset JSDoc if we hit a non-comment, non-blank line
    if (line.trim() && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) {
      currentJsdoc = "";
    }
  }

  return signatures;
}

export function parsePythonFunctions(content: string): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(\S+))?\s*:/);
    if (!match) continue;

    const indent = match[1].length;
    const name = match[2];
    const params = match[3] ? match[3].split(",").map((p) => p.trim()).filter(Boolean) : [];
    const returnType = match[4] ?? "None";

    // Look for docstring
    let docstring = "";
    if (i + 1 < lines.length && lines[i + 1].trim().startsWith('"""')) {
      let j = i + 1;
      while (j < lines.length) {
        docstring += lines[j] + "\n";
        if (j > i + 1 && lines[j].trim().endsWith('"""')) break;
        if (lines[j].trim().startsWith('"""') && lines[j].trim().endsWith('"""') && lines[j].trim().length > 3) break;
        j++;
      }
    }

    signatures.push({
      name,
      params,
      returnType,
      jsdoc: docstring.trim(),
      exported: indent === 0 && !name.startsWith("_"),
    });
  }

  return signatures;
}

function formatFunctionDoc(fn: FunctionSignature): string {
  let md = `### \`${fn.name}(${fn.params.join(", ")})\`\n\n`;
  md += `**Returns**: \`${fn.returnType}\`\n\n`;
  if (fn.jsdoc) {
    md += `${fn.jsdoc}\n\n`;
  }
  return md;
}

function categorizeCommit(message: string): string {
  const lower = message.toLowerCase();
  if (lower.startsWith("feat") || lower.includes("add ") || lower.includes("new ")) return "feat";
  if (lower.startsWith("fix") || lower.includes("bug") || lower.includes("patch")) return "fix";
  if (lower.startsWith("doc") || lower.includes("readme")) return "docs";
  if (lower.startsWith("refactor") || lower.includes("clean")) return "refactor";
  if (lower.startsWith("test") || lower.includes("spec")) return "test";
  if (lower.startsWith("chore") || lower.includes("deps") || lower.includes("bump")) return "chore";
  return "other";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDoc(partial: {
  title: string;
  doc_type: string;
  content: string;
  generated_from?: string;
}): GeneratedDocument {
  return {
    id: `local-${Date.now()}`,
    title: partial.title,
    doc_type: partial.doc_type,
    content: partial.content,
    format: "markdown",
    generated_from: partial.generated_from ?? null,
    generated_by: "system",
    revision: 1,
    tokens_used: 0,
    downloads: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function rowToDocument(row: Record<string, unknown>): GeneratedDocument {
  return {
    id: row.id as string,
    title: row.title as string,
    doc_type: row.doc_type as string,
    content: row.content as string,
    format: (row.format as string) ?? "markdown",
    generated_from: (row.generated_from as string) ?? null,
    generated_by: row.generated_by as string,
    revision: Number(row.revision ?? 1),
    tokens_used: Number(row.tokens_used ?? 0),
    downloads: Number(row.downloads ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Deterministic syntax check over generated code.
 *
 * Found by dogfooding: the factory (diff mode) emitted a file whose unified-diff
 * hunk header undercounted its lines, so the parser dropped the closing brace.
 * The result did not compile (TS1005 '}' expected), yet the security gate - which
 * scans for secrets/injection, not "does this parse" - marked it allow /
 * ready_for_pr. CI caught it downstream, but the verdict was wrong and it burned
 * a PR cycle.
 *
 * This parses each generated TS/JS file with the TypeScript compiler and reports
 * SYNTACTIC errors (not type errors - those need the whole program). It is the
 * "does it even parse" gate: cheap, deterministic, zero-model, and it makes
 * truncated or malformed output impossible to mark ready.
 */
import * as ts from "typescript";

const TS_LIKE = /\.(tsx?|jsx?|mjs|cjs)$/i;

export interface SyntaxIssue {
  path: string;
  line: number;
  message: string;
}
export interface SyntaxResult {
  ok: boolean;
  issues: SyntaxIssue[];
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(mjs|cjs|js)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Parse each TS/JS file and collect SYNTACTIC diagnostics. Pure: no IO, no
 *  program/type-checker. Non-code files (json, md, ...) are skipped. */
export function checkSyntax(files: readonly { path: string; content: string }[]): SyntaxResult {
  const issues: SyntaxIssue[] = [];
  for (const f of files) {
    if (!TS_LIKE.test(f.path)) continue;
    const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, false, scriptKind(f.path));
    // parseDiagnostics carries syntax errors (unterminated blocks, unexpected
    // tokens, a missing "}"). It is not on the public type but is stable.
    const diags = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
    for (const d of diags) {
      const pos = typeof d.start === "number" ? d.start : 0;
      const { line } = sf.getLineAndCharacterOfPosition(pos);
      issues.push({ path: f.path, line: line + 1, message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
    }
  }
  return { ok: issues.length === 0, issues };
}

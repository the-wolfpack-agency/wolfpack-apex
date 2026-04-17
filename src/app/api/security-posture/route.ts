/**
 * GET /api/security-posture (alias: /security-posture)
 *
 * Publicly accessible — no authentication required.
 * Renders the docs/security-posture.md file as HTML.
 * Emits a system.security_posture_viewed analytics event.
 *
 * No new markdown library added — uses the same lightweight string-replace
 * renderer already used in the docs page.
 *
 * PUBLIC: security posture page is intentionally reachable unauthenticated
 * so customers and vendors can review our security practices before sign-in.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { trackEvent } from "@/lib/analytics";
import { createHash } from "crypto";

function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.*?)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*?)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*?)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/^\|(.+)\|$/gm, (line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => `<td>${c.trim()}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .replace(/^---+$/gm, "<hr>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<[htrpc])(.+)$/gm, "$1");
}

function buildHtml(bodyContent: string, rawMd: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Security Posture — Wolfpack Instinct</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 2rem 1rem; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 2rem; border-bottom: 2px solid #e5e7eb; padding-bottom: .5rem; }
    h2 { font-size: 1.4rem; margin-top: 2rem; }
    h3 { font-size: 1.15rem; margin-top: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    td, th { border: 1px solid #d1d5db; padding: .5rem .75rem; }
    tr:nth-child(even) td { background: #f9fafb; }
    code { background: #f3f4f6; padding: .1rem .3rem; border-radius: 3px; font-size: .9em; }
    a { color: #2563eb; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
    p { margin: .75rem 0; }
  </style>
</head>
<body>
  <div id="content">${bodyContent}</div>
  <details style="margin-top:2rem;color:#6b7280;font-size:.85rem">
    <summary>Raw markdown</summary>
    <pre style="white-space:pre-wrap;word-break:break-word">${rawMd.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>
  </details>
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Emit analytics — user_agent_hash for privacy-preserving attribution
  const ua = request.headers.get("user-agent") ?? "";
  const uaHash = createHash("sha256").update(ua).digest("hex").slice(0, 16);
  trackEvent("system.security_posture_viewed", "anonymous", "public", {
    user_agent_hash: uaHash,
  });

  let markdown: string;
  try {
    const mdPath = join(process.cwd(), "docs", "security-posture.md");
    markdown = readFileSync(mdPath, "utf-8");
  } catch {
    return NextResponse.json(
      { error: "Security posture document not found" },
      { status: 404 },
    );
  }

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    const rendered = renderMarkdown(markdown);
    const html = buildHtml(rendered, markdown);
    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // JSON / default: return raw markdown
  return NextResponse.json({ content: markdown, format: "markdown" });
}

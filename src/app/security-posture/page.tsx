/**
 * /security-posture — Public page.
 * Server component that reads the markdown doc and renders it inline.
 * No auth required.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** A run of `| a | b |` lines becomes one real <table>: the first row is the
 *  header, the `|---|` separator row is dropped. A bare <tr> outside a <table>
 *  is discarded by the HTML parser, which ran every cell's text together. */
function renderTable(block: string): string {
  const rows = block
    .trim()
    .split("\n")
    .filter((l) => !/^\|[\s:|-]+\|$/.test(l.trim()))
    .map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const th = head.map((c) => `<th class="border border-gray-300 px-3 py-1.5 text-left text-sm font-semibold">${c}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${r.map((c) => `<td class="border border-gray-300 px-3 py-1.5 text-sm align-top">${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="overflow-x-auto"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>\n`;
}

function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.*?)$/gm, '<h3 class="text-lg font-semibold mt-5 mb-2">$1</h3>')
    .replace(/^## (.*?)$/gm, '<h2 class="text-xl font-bold mt-8 mb-3 border-b pb-1">$1</h2>')
    .replace(/^# (.*?)$/gm, '<h1 class="text-3xl font-bold mt-4 mb-6">$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 rounded text-sm">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" class="text-blue-600 underline">$1</a>')
    .replace(/(?:^\|.+\|[ \t]*(?:\n|$))+/gm, (block) => renderTable(block))
    .replace(/^---+$/gm, "<hr>")
    .replace(/\n\n/g, "\n");
}

export default function SecurityPosturePage() {
  let html = "";
  try {
    const mdPath = join(process.cwd(), "docs", "security-posture.md");
    const md = readFileSync(mdPath, "utf-8");
    html = renderMarkdown(md);
  } catch {
    html = "<p>Security posture document unavailable.</p>";
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-10 text-gray-900">
      <article
        className="prose prose-neutral max-w-none [&_table]:border-collapse [&_table]:w-full [&_table]:my-4"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </main>
  );
}

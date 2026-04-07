// Build the Complete Infrastructure & Cost Report PDF.
// Reads the markdown source, converts to styled HTML (matching the prior
// Wolfpack report aesthetic), writes the HTML, then invokes headless
// Chrome to render the PDF.
//
// Usage: node reports/_build_complete_infra_pdf.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MD_PATH = resolve(__dirname, "wolfpack-complete-infrastructure-costs-2026.md");
const HTML_PATH = resolve(__dirname, "_complete_infra.tmp.html");
const PDF_PATH = resolve(__dirname, "Wolfpack_Complete_Infrastructure_Costs_2026.pdf");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// --- Minimal markdown → HTML (covers what this report uses: headings,
// paragraphs, lists, bold, italic, inline code, hr, tables, blockquote)
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const inline = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Table — header line followed by separator line of |---|---|
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = line.split("|").map((c) => c.trim()).filter((_, idx, arr) =>
        !(idx === 0 && arr[0] === "") && !(idx === arr.length - 1 && arr[arr.length - 1] === ""),
      );
      i += 2; // skip header and separator
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        const row = lines[i]
          .split("|")
          .map((c) => c.trim())
          .filter((_, idx, arr) =>
            !(idx === 0 && arr[0] === "") && !(idx === arr.length - 1 && arr[arr.length - 1] === ""),
          );
        rows.push(row);
        i++;
      }
      let html = "<table><thead><tr>";
      for (const h of header) html += `<th>${inline(h)}</th>`;
      html += "</tr></thead><tbody>";
      for (const r of rows) {
        html += "<tr>";
        for (const c of r) html += `<td>${inline(c)}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
      out.push(html);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push("<ul>" + items.map((it) => `<li>${inline(it)}</li>`).join("") + "</ul>");
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push("<ol>" + items.map((it) => `<li>${inline(it)}</li>`).join("") + "</ol>");
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (collect until blank line / heading / list / hr / table)
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

const css = `
  @page { size: Letter; margin: 0.75in 0.75in 0.85in 0.75in; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    font-size: 10.5pt;
    line-height: 1.5;
    margin: 0;
  }
  h1 {
    font-size: 22pt;
    color: #1a1a2e;
    margin: 0 0 6pt 0;
    border-bottom: 3px solid #fbbf24;
    padding-bottom: 8pt;
  }
  h2 {
    font-size: 15pt;
    color: #1a1a2e;
    margin: 22pt 0 8pt 0;
    border-bottom: 2px solid #fbbf24;
    padding-bottom: 5pt;
  }
  h3 {
    font-size: 12pt;
    color: #1a1a2e;
    margin: 16pt 0 5pt 0;
  }
  h4 { font-size: 11pt; color: #1a1a2e; margin: 12pt 0 4pt 0; }
  p { margin: 6pt 0; }
  hr {
    border: none;
    border-top: 1px solid #e5e5e5;
    margin: 16pt 0;
  }
  ul, ol { margin: 6pt 0 6pt 18pt; padding: 0; }
  li { margin: 2pt 0; }
  strong { color: #1a1a2e; }
  code {
    font-family: "SF Mono", Menlo, Monaco, monospace;
    background: #f4f4f6;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9.5pt;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8pt 0 12pt 0;
    font-size: 9.5pt;
  }
  th {
    background: #1a1a2e;
    color: #fbbf24;
    text-align: left;
    padding: 7pt 9pt;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 8.5pt;
    letter-spacing: 0.4pt;
  }
  td {
    padding: 7pt 9pt;
    border-bottom: 1px solid #ececec;
    vertical-align: top;
  }
  tbody tr:nth-child(even) td { background: #fafafa; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr td:first-child { font-weight: 500; }
  /* Highlight any row whose first cell is bold (subtotals/totals) */
  tbody tr td strong:only-child { color: #b8860b; }
  /* Cover-style first heading */
  body > h1:first-of-type {
    text-align: left;
  }
`;

const md = readFileSync(MD_PATH, "utf-8");
const body = mdToHtml(md);
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Wolfpack Agency — Complete Infrastructure & Cost Report</title>
    <style>${css}</style>
  </head>
  <body>
    ${body}
  </body>
</html>`;

writeFileSync(HTML_PATH, html, "utf-8");

// Render with headless Chrome
const cmd = `"${CHROME}" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="${PDF_PATH}" "file://${HTML_PATH}"`;
execSync(cmd, { stdio: "inherit" });
console.log(`PDF written to ${PDF_PATH}`);

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the repo's agent-context convention:
 *   - Root CLAUDE.md must exist and @-include every .ai/*.md file.
 *   - Every .ai/*.md file must exist, be non-empty, and start with an H1
 *     heading that reflects its topic.
 *
 * If this test fails, the repo's convention has rotted. Fix the file,
 * not the test.
 */

const repoRoot = join(__dirname, "..", "..");
const claudeMdPath = join(repoRoot, "CLAUDE.md");
const aiDir = join(repoRoot, ".ai");

const aiFiles: { name: string; h1Keywords: string[] }[] = [
  { name: "architecture.md", h1Keywords: ["architecture"] },
  { name: "conventions.md", h1Keywords: ["convention"] },
  { name: "integrations.md", h1Keywords: ["integration"] },
  { name: "runbooks.md", h1Keywords: ["runbook"] },
  { name: "client-context.md", h1Keywords: ["client", "context"] },
  { name: "data-stores.md", h1Keywords: ["data", "store"] },
];

describe("AI convention files", () => {
  test("CLAUDE.md exists at repo root", () => {
    expect(existsSync(claudeMdPath)).toBe(true);
  });

  test("CLAUDE.md includes every .ai/*.md file via @-syntax", () => {
    const claudeMd = readFileSync(claudeMdPath, "utf8");
    for (const { name } of aiFiles) {
      expect(claudeMd).toContain(`@.ai/${name}`);
    }
  });

  describe.each(aiFiles)(".ai/$name", ({ name, h1Keywords }) => {
    const filePath = join(aiDir, name);

    test("exists", () => {
      expect(existsSync(filePath)).toBe(true);
    });

    test("is non-empty", () => {
      const size = statSync(filePath).size;
      expect(size).toBeGreaterThan(200);
    });

    test("starts with an H1 heading reflecting its topic", () => {
      const content = readFileSync(filePath, "utf8");
      const firstLine = content.split(/\r?\n/, 1)[0]!.toLowerCase();
      expect(firstLine.startsWith("# ")).toBe(true);
      const matched = h1Keywords.some((kw) => firstLine.includes(kw));
      expect(matched).toBe(true);
    });
  });
});

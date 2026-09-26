/** @jest-environment node
 *
 * The factory runs the FULL platform-scan static engine on the authored files, not
 * just the curated ai-code subset. A provider-signature secret is critical and
 * blocks the handoff; a clean file passes; a modification-only diff (no new files)
 * is out of scope today and does not block.
 */
import { deepScanChange } from "../deep-scan";

function newFile(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => "+" + l),
  ].join("\n");
}

const EDIT_ONLY = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-const x = 1;
+const x = 2;`;

describe("deepScanChange", () => {
  it("BLOCKS on a critical provider-signature secret the ai-code subset might not catch", async () => {
    // A hardcoded AWS access key id - the deep detector flags it as critical.
    const diff = newFile("src/config.ts", ['export const KEY = "AKIA1234567890ABCDEF";']);
    const s = await deepScanChange(diff);
    expect(s.scanned).toBe(1);
    expect(s.critical).toBeGreaterThan(0);
    expect(s.blocking).toBe(true);
  });

  it("passes a clean new file", async () => {
    const s = await deepScanChange(newFile("src/lib/add.ts", ["export const add = (a: number, b: number) => a + b;"]));
    expect(s.scanned).toBe(1);
    expect(s.critical).toBe(0);
    expect(s.blocking).toBe(false);
  });

  it("is a no-op (not blocking) for a modification-only diff - editing existing files is the workspace stage", async () => {
    const s = await deepScanChange(EDIT_ONLY);
    expect(s.scanned).toBe(0);
    expect(s.blocking).toBe(false);
  });
});

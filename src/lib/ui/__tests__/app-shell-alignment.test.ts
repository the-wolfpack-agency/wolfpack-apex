/**
 * The three bars across the top of the shell must end on the same line.
 *
 * They are in three different places in the layout and there is no rendering
 * check that would notice them drifting apart: each one is individually valid
 * CSS, and the defect only exists in the relationship between them. It shipped
 * exactly that way, with the sidebar's border sitting 12px below the top bar's.
 *
 * jsdom does no layout, so a render test cannot measure this and would give a
 * false sense of coverage. What CAN be checked deterministically is the rule
 * that makes the heights equal: every bar declares the shared height, and none
 * of them reintroduces the vertical padding that caused the drift.
 */
import { readFileSync } from "node:fs";
import { APP_SHELL_BAR_HEIGHT } from "@/lib/ui/app-shell";

const LAYOUT = "src/app/(dashboard)/layout.tsx";

/** The class attribute of each top bar, identified by what makes it unique. */
const BARS: Array<{ name: string; marker: RegExp }> = [
  { name: "sidebar brand block", marker: /className=\{`flex items-center gap-3 px-5 [^`]*`\}/ },
  { name: "mobile header", marker: /className=\{`lg:hidden flex items-center gap-3 px-4 [^`]*`\}/ },
  { name: "desktop top bar", marker: /className=\{`hidden lg:flex items-center justify-end gap-2 px-6 [^`]*`\}/ },
];

describe("app shell top bars", () => {
  const source = readFileSync(LAYOUT, "utf8");

  it.each(BARS)("$name declares the shared height", ({ name, marker }) => {
    const m = marker.exec(source);
    expect(`${name}:${m !== null}`).toBe(`${name}:true`);
    expect(m![0]).toContain(`\${APP_SHELL_BAR_HEIGHT}`);
  });

  /* Vertical padding is what broke it: three bars padded around contents of
     three different heights cannot line up, because each result depends on its
     own tallest child. An explicit height plus centring is what holds them
     level, so py-* coming back is the regression. */
  it.each(BARS)("$name uses no vertical padding, which is what caused the drift", ({ name, marker }) => {
    const cls = marker.exec(source)![0];
    expect(`${name}:${/\bpy-[\d.]+\b/.test(cls)}`).toBe(`${name}:false`);
  });

  /* Centring is what makes an explicit height safe: without it a short child
     sits at the top of a tall bar and the fix looks worse than the bug. */
  it.each(BARS)("$name centers its contents vertically", ({ name, marker }) => {
    expect(marker.exec(source)![0]).toContain("items-center");
  });

  it("keeps every bar on ONE height, so changing it moves them together", () => {
    const heights = BARS.map((b) => {
      const cls = marker(b.marker, source);
      return /\$\{APP_SHELL_BAR_HEIGHT\}/.test(cls) ? APP_SHELL_BAR_HEIGHT : "literal";
    });
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(APP_SHELL_BAR_HEIGHT);
  });
});

function marker(re: RegExp, source: string): string {
  const m = re.exec(source);
  if (!m) throw new Error(`bar not found: ${re}`);
  return m[0];
}

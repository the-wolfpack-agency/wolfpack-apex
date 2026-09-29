/**
 * buildGroundingBlock: the repo shape the author needs so it never invents an
 * import. Directly targets tonight's failures - it must tell the model which
 * modules exist (or that none do), where tests go, which test libraries are
 * installed, and that pages/ files are routes.
 */
import { buildGroundingBlock } from "@/lib/ai-code/repo-grounding";

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: deps, devDependencies: dev });

test("no shared lib helpers -> instructs self-contained code (no invented imports)", () => {
  const block = buildGroundingBlock(["src/pages/index.tsx"], pkg({ next: "15", react: "18" }));
  expect(block).toMatch(/No shared lib\/ helpers/i);
  expect(block).toMatch(/self-contained/i);
  expect(block).toMatch(/Never import a module that is not present/i);
});

test("lists the modules that actually exist so the author imports those", () => {
  const block = buildGroundingBlock(
    ["src/lib/db.ts", "src/lib/auth.ts", "src/utils/format.ts", "src/pages/index.tsx"],
    pkg({ next: "15" }),
  );
  expect(block).toMatch(/import from these/i);
  expect(block).toContain("src/lib/db.ts");
  expect(block).toContain("src/lib/auth.ts");
  expect(block).toContain("src/utils/format.ts");
});

test("Next.js pages router is flagged so a test/helper is never dropped into pages/", () => {
  const block = buildGroundingBlock(["src/pages/api/x.ts"], pkg({ next: "15" }));
  expect(block).toMatch(/Next\.js \(router: pages\)/);
  expect(block).toMatch(/every file under pages\/ is a route/i);
});

test("no React Testing Library installed -> forbids component-render tests", () => {
  const block = buildGroundingBlock(
    ["src/lib/x.ts", "src/lib/__tests__/x.test.ts"],
    pkg({ next: "15" }, { jest: "30", "ts-jest": "29" }),
  );
  expect(block).toMatch(/tests run with jest/i);
  expect(block).toMatch(/__tests__ directory/i);
  expect(block).toContain("src/lib/__tests__");
  expect(block).toMatch(/React Testing Library is NOT installed/i);
  expect(block).toMatch(/do not write component-render tests/i);
});

test("React Testing Library present -> does NOT forbid component tests", () => {
  const block = buildGroundingBlock(
    ["src/lib/x.ts"],
    pkg({ next: "15" }, { jest: "30", "@testing-library/react": "16" }),
  );
  expect(block).not.toMatch(/do not write component-render tests/i);
});

test("Playwright dep -> notes e2e uses Playwright", () => {
  const block = buildGroundingBlock(["src/lib/x.ts"], pkg({ next: "15" }, { jest: "30", "@playwright/test": "1" }));
  expect(block).toMatch(/Playwright/);
  expect(block).not.toMatch(/do NOT write e2e/i);
});

test("no e2e framework installed -> forbids e2e tests (avoids the phantom @playwright/test import)", () => {
  // Dogfooding a web page: the model wrote a Playwright e2e test on a repo with no
  // Playwright -> phantom import -> blocked. Grounding must forbid it up front.
  const block = buildGroundingBlock(["app/page.tsx"], pkg({ next: "15", react: "18" }, { jest: "30" }));
  expect(block).toMatch(/No end-to-end framework .* installed: do NOT write e2e/i);
});

test("no test runner installed -> says so, does not tell it to add tests needing one", () => {
  const block = buildGroundingBlock(["src/lib/x.ts"], pkg({ next: "15" }));
  expect(block).toMatch(/No unit-test runner is installed/i);
});

test("empty inputs -> empty block (nothing to ground on)", () => {
  expect(buildGroundingBlock([], null)).toBe("");
});

test("malformed package.json -> still produces a block from the tree, no throw", () => {
  const block = buildGroundingBlock(["src/lib/x.ts"], "{not json");
  expect(block).toContain("src/lib/x.ts");
});
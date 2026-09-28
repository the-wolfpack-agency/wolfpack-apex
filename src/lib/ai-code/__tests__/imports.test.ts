/**
 * Phantom-dependency detector: catches the "imported a package not in
 * package.json" hallucination (the apex `nookies` dogfooding failure) before it
 * ships a change that always fails CI.
 */
import {
  packageRoot,
  extractBareImports,
  parseInstalledRoots,
  findPhantomImports,
  phantomImportFeedback,
} from "@/lib/ai-code/imports";

describe("packageRoot", () => {
  it.each([
    ["nookies", "nookies"],
    ["lodash/fp", "lodash"],
    ["@scope/pkg", "@scope/pkg"],
    ["@scope/pkg/sub/deep", "@scope/pkg"],
    ["node:fs", "fs"],
    ["next/server", "next"],
  ])("%s -> %s", (spec, root) => {
    expect(packageRoot(spec)).toBe(root);
  });
});

describe("extractBareImports", () => {
  it("collects static, side-effect, dynamic, and require specifiers - external only", () => {
    const src = `
      import { a } from "pkg-a";
      import type { T } from "@scope/types";
      import "side-effect-pkg";
      export { z } from "pkg-b";
      const m = await import("dyn-pkg");
      const r = require("req-pkg");
      import local from "./local";
      import alias from "@/lib/x";
      import up from "../up";
      import n from "node:crypto";
    `;
    const got = extractBareImports(src);
    expect(got).toEqual(
      expect.arrayContaining(["pkg-a", "@scope/types", "side-effect-pkg", "pkg-b", "dyn-pkg", "req-pkg", "node:crypto"]),
    );
    // Local/alias/relative are excluded.
    expect(got).not.toContain("./local");
    expect(got).not.toContain("@/lib/x");
    expect(got).not.toContain("../up");
  });

  it("dedupes repeated specifiers", () => {
    const got = extractBareImports(`import {a} from "x";\nimport {b} from "x";`);
    expect(got).toEqual(["x"]);
  });
});

describe("parseInstalledRoots", () => {
  it("collects deps, devDeps, peer, and optional", () => {
    const pkg = JSON.stringify({
      dependencies: { next: "1", pg: "2" },
      devDependencies: { jest: "3" },
      peerDependencies: { react: "4" },
      optionalDependencies: { sharp: "5" },
    });
    const roots = parseInstalledRoots(pkg);
    expect([...roots].sort()).toEqual(["jest", "next", "pg", "react", "sharp"]);
  });
  it("returns an empty set on malformed JSON (fail-open)", () => {
    expect(parseInstalledRoots("{ not json").size).toBe(0);
  });
});

describe("findPhantomImports", () => {
  const installed = new Set(["next", "pg", "react"]);

  it("flags an import of a package not in package.json (the nookies case)", () => {
    const files = [{ path: "src/x.test.ts", content: `import { parseCookies } from "nookies";` }];
    expect(findPhantomImports(files, installed)).toEqual([{ path: "src/x.test.ts", module: "nookies" }]);
  });

  it("does NOT flag installed packages, Node builtins, or local/alias imports", () => {
    const files = [{
      path: "src/x.ts",
      content: `import { NextResponse } from "next/server";\nimport fs from "fs";\nimport n from "node:path";\nimport x from "./local";\nimport y from "@/lib/y";\nimport pg from "pg";`,
    }];
    expect(findPhantomImports(files, installed)).toEqual([]);
  });

  it("fails open: no installed set known -> flags nothing (never false-flag)", () => {
    const files = [{ path: "a.ts", content: `import x from "definitely-not-installed";` }];
    expect(findPhantomImports(files, new Set())).toEqual([]);
  });

  it("maps a subpath import to its package root before checking", () => {
    const files = [{ path: "a.ts", content: `import x from "left-pad/index";` }];
    expect(findPhantomImports(files, installed)).toEqual([{ path: "a.ts", module: "left-pad" }]);
  });
});

describe("phantomImportFeedback", () => {
  it("names the phantom modules and tells the model not to import them", () => {
    const fb = phantomImportFeedback([{ path: "a", module: "nookies" }, { path: "b", module: "nookies" }]);
    expect(fb).toMatch(/nookies/);
    expect(fb).toMatch(/not in package\.json/i);
    expect(fb).toMatch(/Cannot find module/);
  });
});

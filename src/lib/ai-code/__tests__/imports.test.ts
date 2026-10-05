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
  extractLocalImports,
  extractExportedNames,
  parseAliasMap,
  resolveLocalCandidates,
  findBrokenLocalImports,
  brokenLocalImportFeedback,
  locateSymbolSpec,
  autoFixImports,
  autoCorrectImports,
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

describe("extractLocalImports", () => {
  it("captures named members (pre-`as`), default, and namespace; ignores bare packages", () => {
    const content = [
      `import { recordEvent } from "@/lib/admin/analytics";`,
      `import { listAllGuests as g } from "@/lib/admin/guest-profile";`,
      `import Default, { type Foo, bar } from "../x";`,
      `import * as ns from "@/lib/ns";`,
      `import { nothingLocal } from "zod";`,
      `import "./side-effect";`,
    ].join("\n");
    const li = extractLocalImports("app/r/route.ts", content);
    const bySpec = Object.fromEntries(li.map((l) => [l.spec, l]));
    expect(bySpec["@/lib/admin/analytics"].names).toEqual(["recordEvent"]);
    expect(bySpec["@/lib/admin/guest-profile"].names).toEqual(["listAllGuests"]); // original name, not alias
    expect(bySpec["../x"].names.sort()).toEqual(["Foo", "bar"]);
    expect(bySpec["../x"].hasDefault).toBe(true);
    expect(bySpec["@/lib/ns"].hasNamespace).toBe(true);
    expect(bySpec["zod"]).toBeUndefined(); // bare package -> not a local import
  });
});

describe("extractExportedNames", () => {
  it("collects declarations, re-exports (post-`as`), default, and the wildcard flag", () => {
    const content = [
      `export function guestPreferenceProfile() {}`,
      `export const GUEST_EXPORT_HEADER = [];`,
      `export type GuestExportRow = { a: 1 };`,
      `export { internalThing as publicName };`,
      `export default function Page() {}`,
    ].join("\n");
    const e = extractExportedNames(content);
    expect(e.names.has("guestPreferenceProfile")).toBe(true);
    expect(e.names.has("GUEST_EXPORT_HEADER")).toBe(true);
    expect(e.names.has("GuestExportRow")).toBe(true);
    expect(e.names.has("publicName")).toBe(true);
    expect(e.names.has("internalThing")).toBe(false); // the private side of a rename is not exported
    expect(e.hasDefault).toBe(true);
    expect(e.hasWildcard).toBe(false);
  });
  it("sets hasWildcard on `export * from` (names become unprovable)", () => {
    expect(extractExportedNames(`export * from "./barrel";`).hasWildcard).toBe(true);
    expect(extractExportedNames(`export * as ns from "./barrel";`).hasWildcard).toBe(false);
  });
});

describe("parseAliasMap + resolveLocalCandidates", () => {
  it("parses @/* -> src/ and resolves an alias import to repo file candidates", () => {
    const map = parseAliasMap(`{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`);
    expect(map["@/"]).toBe("src/");
    const cands = resolveLocalCandidates("src/app/r/route.ts", "@/lib/admin/analytics", map);
    expect(cands).toContain("src/lib/admin/analytics.ts");
  });
  it("resolves @/* -> repo root (WWP shape, no src dir)", () => {
    const map = parseAliasMap(`{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`);
    const cands = resolveLocalCandidates("app/api/x/route.ts", "@/lib/admin/analytics", map);
    expect(cands).toContain("lib/admin/analytics.ts");
  });
  it("resolves a relative import, collapsing ..", () => {
    const cands = resolveLocalCandidates("app/api/admin/guests/export/route.ts", "../../../../lib/x", {});
    expect(cands).toContain("app/lib/x.ts");
  });
});

describe("findBrokenLocalImports (the #229 gap)", () => {
  // The WWP admin modules as they actually are.
  const repo: Record<string, string> = {
    "lib/admin/analytics.ts": `export async function recordEvent() {}`,
    "lib/admin/guest-profile.ts": `export function guestPreferenceProfile() {}`, // NO listAllGuests
    "lib/admin/guest-export.ts": `export function guestsToCsv() {} export function guestExportFilename() {} export type GuestExportRow = {};`,
  };
  const aliasMap = { "@/": "" };
  const resolve = (fromPath: string, spec: string) => {
    for (const cand of resolveLocalCandidates(fromPath, spec, aliasMap)) {
      if (cand in repo) return { exists: true, content: repo[cand] };
    }
    return { exists: false, content: null };
  };

  it("reproduces #229: flags the wrong-path import, the missing export, and the missing module", () => {
    const route = {
      path: "app/api/admin/guests/export/route.ts",
      content: [
        `import { recordEvent } from "@/lib/analytics";`,            // wrong module: @/lib/analytics has no file here
        `import { listAllGuests } from "@/lib/admin/guest-profile";`, // real module, missing export
        `import { x } from "@/lib/test-helpers";`,                    // module does not exist
        `import { guestsToCsv } from "@/lib/admin/guest-export";`,    // valid - must NOT be flagged
      ].join("\n"),
    };
    const broken = findBrokenLocalImports([route], resolve);
    const keys = broken.map((b) => `${b.kind}:${b.spec}${b.name ? ":" + b.name : ""}`);
    expect(keys).toContain("missing_module:@/lib/analytics");
    expect(keys).toContain("missing_export:@/lib/admin/guest-profile:listAllGuests");
    expect(keys).toContain("missing_module:@/lib/test-helpers");
    // the one correct import is not flagged
    expect(keys.some((k) => k.includes("guest-export"))).toBe(false);
  });

  it("a module authored in the SAME change is readable and validated", () => {
    const files = [
      { path: "app/api/x/route.ts", content: `import { listProgramGuestRows } from "@/lib/admin/guest-export-data";` },
      { path: "lib/admin/guest-export-data.ts", content: `export async function listProgramGuestRows() { return []; }` },
    ];
    const withChange: ModuleResolverTest = (fromPath, spec) => {
      for (const cand of resolveLocalCandidates(fromPath, spec, aliasMap)) {
        const f = files.find((x) => x.path === cand);
        if (f) return { exists: true, content: f.content };
        if (cand in repo) return { exists: true, content: repo[cand] };
      }
      return { exists: false, content: null };
    };
    expect(findBrokenLocalImports(files, withChange)).toEqual([]);
  });

  it("fails open: a module that exists but is unreadable (content null) is not name-checked", () => {
    const r = () => ({ exists: true, content: null });
    const files = [{ path: "a.ts", content: `import { whoKnows } from "@/lib/opaque";` }];
    expect(findBrokenLocalImports(files, r)).toEqual([]);
  });

  it("fails open on `export *` re-export barrels", () => {
    const r = () => ({ exists: true, content: `export * from "./somewhere";` });
    const files = [{ path: "a.ts", content: `import { couldBeReexported } from "@/lib/barrel";` }];
    expect(findBrokenLocalImports(files, r)).toEqual([]);
  });
});

type ModuleResolverTest = (fromPath: string, spec: string) => { exists: boolean; content: string | null };

describe("brokenLocalImportFeedback", () => {
  it("names the bad path and the bad symbol for the retry", () => {
    const fb = brokenLocalImportFeedback([
      { path: "r.ts", spec: "@/lib/test-helpers", kind: "missing_module" },
      { path: "r.ts", spec: "@/lib/admin/guest-profile", kind: "missing_export", name: "listAllGuests" },
    ]);
    expect(fb).toMatch(/@\/lib\/test-helpers/);
    expect(fb).toMatch(/listAllGuests/);
    expect(fb).toMatch(/has no exported member|NOT exported/i);
  });
});


describe("resolveLocalCandidates @/ fallback (alias map unavailable at runtime)", () => {
  it("resolves @/ imports to src/ even with an EMPTY alias map (the broken-imports false positive)", () => {
    const c = resolveLocalCandidates("src/app/api/admin/x/route.ts", "@/lib/auth", {});
    expect(c).toContain("src/lib/auth.ts");
    expect(c).toContain("src/lib/auth/index.ts");
  });
  it("still prefers the REAL alias map when present", () => {
    const c = resolveLocalCandidates("src/x.ts", "~/lib/thing", { "~/": "app/" });
    expect(c).toContain("app/lib/thing.ts");
  });
  it("does not treat a bare package as a local module", () => {
    expect(resolveLocalCandidates("src/x.ts", "react", {})).toEqual([]);
    expect(resolveLocalCandidates("src/x.ts", "@scope/pkg", {})).toEqual([]);
  });
});


describe("locateSymbolSpec (tell the model WHERE a symbol really lives)", () => {
  const tree = new Set(["src/lib/auth.ts", "src/lib/auth/require-capability.ts", "src/components/support/StatusPill.tsx", "src/lib/auth/workspace.ts"]);
  it("locates a camelCase symbol by its kebab-case file (requireCapability -> .../require-capability)", () => {
    expect(locateSymbolSpec("requireCapability", tree)).toBe("@/lib/auth/require-capability");
  });
  it("locates a PascalCase component (StatusPill -> .../StatusPill)", () => {
    expect(locateSymbolSpec("StatusPill", tree)).toBe("@/components/support/StatusPill");
  });
  it("returns null when the symbol has no matching file", () => {
    expect(locateSymbolSpec("totallyMadeUp", tree)).toBeNull();
    expect(locateSymbolSpec("x", new Set())).toBeNull();
  });
});

describe("brokenLocalImportFeedback uses the hint", () => {
  it("names the correct module when a hint is present", () => {
    const fb = brokenLocalImportFeedback([{ path: "src/app/api/x/route.ts", spec: "@/lib/auth", kind: "missing_export", name: "requireCapability", hint: "@/lib/auth/require-capability" }]);
    expect(fb).toMatch(/Import it from "@\/lib\/auth\/require-capability" instead/);
  });
  it("falls back to the generic message without a hint", () => {
    const fb = brokenLocalImportFeedback([{ path: "src/app/api/x/route.ts", spec: "@/lib/foo", kind: "missing_export", name: "bar" }]);
    expect(fb).toMatch(/module that actually defines "bar"/);
  });
});


describe("autoFixImports (deterministically correct the model's wrong imports)", () => {
  const tree = new Set(["src/lib/auth.ts", "src/lib/auth/require-capability.ts"]);
  it("fixes the double-prefix @/src/lib/auth -> @/lib/auth (verified to resolve)", () => {
    const r = autoFixImports([{ path: "src/app/x/route.ts", content: `import { a } from "@/src/lib/auth";` }], tree, { "@/": "src/" });
    expect(r.fixes).toEqual([{ path: "src/app/x/route.ts", from: "@/src/lib/auth", to: "@/lib/auth" }]);
    expect(r.files[0].content).toContain('from "@/lib/auth"');
  });
  it("relocates a single wrong-module symbol when the module is missing", () => {
    // @/lib/nope does not resolve; requireCapability lives in require-capability.ts
    const r = autoFixImports([{ path: "src/app/x/route.ts", content: `import { requireCapability } from "@/lib/nope";` }], tree, { "@/": "src/" });
    expect(r.fixes[0]?.to).toBe("@/lib/auth/require-capability");
  });
  it("NEVER touches an import that already resolves", () => {
    const r = autoFixImports([{ path: "src/app/x/route.ts", content: `import { a } from "@/lib/auth";` }], tree, { "@/": "src/" });
    expect(r.fixes).toEqual([]);
    expect(r.files[0].content).toContain('from "@/lib/auth"');
  });
  it("leaves a genuinely unfixable import alone", () => {
    const r = autoFixImports([{ path: "src/app/x/route.ts", content: `import { a } from "@/totally/made/up";` }], tree, { "@/": "src/" });
    expect(r.fixes).toEqual([]);
  });
});


describe("autoCorrectImports (pure fix + hint relocation, reports what REMAINS)", () => {
  const tree = new Set(["src/lib/auth.ts", "src/lib/auth/require-capability.ts"]);
  it("relocates a wrong-module symbol via the injected check's hint, leaving nothing remaining", async () => {
    // @/lib/auth resolves but does NOT export requireCapability; the check supplies the hint.
    const check = async (files: readonly { path: string; content: string }[]) =>
      files.some((f) => f.content.includes('from "@/lib/auth"') && f.content.includes("requireCapability"))
        ? [{ path: "src/app/x/route.ts", spec: "@/lib/auth", kind: "missing_export" as const, name: "requireCapability", hint: "@/lib/auth/require-capability" }]
        : [];
    const r = await autoCorrectImports([{ path: "src/app/x/route.ts", content: `import { requireCapability } from "@/lib/auth";` }], tree, { "@/": "src/" }, check);
    expect(r.fixes.map((f) => f.to)).toContain("@/lib/auth/require-capability");
    expect(r.files[0].content).toContain('from "@/lib/auth/require-capability"');
    expect(r.remaining).toEqual([]); // re-check finds it clean -> no escalation needed
  });
  it("reports a genuinely-broken import as remaining (escalation IS warranted)", async () => {
    const check = async () => [{ path: "src/app/x/route.ts", spec: "@/lib/ghost", kind: "missing_module" as const }];
    const r = await autoCorrectImports([{ path: "src/app/x/route.ts", content: `import { z } from "@/lib/ghost";` }], tree, { "@/": "src/" }, check);
    expect(r.remaining.length).toBe(1); // unfixable -> caller escalates
  });
});

describe("checkLocalImports (the ONE shared checker, fetcher injected)", () => {
  const { parseAliasMap, checkLocalImports } = require("../imports");
  const aliasMap = parseAliasMap(JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  const repoTree = new Set(["src/lib/real.ts"]);
  const fetchModules = async (paths: readonly string[]) =>
    new Map(paths.map((p) => [p, p === "src/lib/real.ts" ? "export const foo = 1;" : null]));

  it("flags an import that resolves to NO file (missing_module)", async () => {
    const files = [{ path: "src/app/x.ts", content: 'import { foo } from "@/lib/ghost";' }];
    const broken = await checkLocalImports(files, { repoTree, aliasMap }, fetchModules);
    expect(broken).toEqual([{ path: "src/app/x.ts", spec: "@/lib/ghost", kind: "missing_module" }]);
  });

  it("flags a name a real module does NOT export (missing_export)", async () => {
    const files = [{ path: "src/app/x.ts", content: 'import { bar } from "@/lib/real";' }];
    const broken = await checkLocalImports(files, { repoTree, aliasMap }, fetchModules);
    expect(broken[0]).toMatchObject({ spec: "@/lib/real", kind: "missing_export", name: "bar" });
  });

  it("passes a valid import (resolves + the name is exported)", async () => {
    const files = [{ path: "src/app/x.ts", content: 'import { foo } from "@/lib/real";' }];
    expect(await checkLocalImports(files, { repoTree, aliasMap }, fetchModules)).toEqual([]);
  });

  it("no-ops on an empty repo tree (unknown -> never flag)", async () => {
    const files = [{ path: "a.ts", content: 'import x from "@/y";' }];
    expect(await checkLocalImports(files, { repoTree: new Set(), aliasMap }, fetchModules)).toEqual([]);
  });

  it("does NOT re-fetch a module authored in THIS change (changeset wins)", async () => {
    const files = [
      { path: "src/app/x.ts", content: 'import { baz } from "@/lib/new-mod";' },
      { path: "src/lib/new-mod.ts", content: "export const baz = 1;" },
    ];
    const broken = await checkLocalImports(files, { repoTree, aliasMap }, fetchModules);
    expect(broken).toEqual([]); // new-mod is in the changeset, not missing
  });
});

/**
 * Known-compromised versions on lockfile changes (PR gate layer).
 *
 * Fixtures use ONLY the packages and versions already listed in
 * security/known-compromised.json (@subql/common 5.8.3, tensorlake 0.5.144,
 * @apexacc/*, litellm) plus benign lockfile diffs as true negatives. No network.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLockfileCompromise,
  lockfileEntriesFromDiff,
  lockfileDiffKind,
  loadBundledKnownCompromised,
  loadKnownCompromised,
  validateKnownCompromised,
  KNOWN_COMPROMISED_PATH,
} from "@/lib/platform-scan/static/lockfile-compromise";

const pkgLock = (...hunk: string[]) =>
  [
    "diff --git a/package-lock.json b/package-lock.json",
    "index 1111111..2222222 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -100,6 +100,12 @@",
    ...hunk,
  ].join("\n");

const pnpmLock = (...hunk: string[]) =>
  [
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "index 1111111..2222222 100644",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "@@ -10,6 +10,10 @@ packages:",
    ...hunk,
  ].join("\n");

describe("lockfileDiffKind", () => {
  it("recognizes the two lockfile formats this check reads", () => {
    expect(lockfileDiffKind("package-lock.json")).toBe("package-lock");
    expect(lockfileDiffKind("apps/web/package-lock.json")).toBe("package-lock");
    expect(lockfileDiffKind("npm-shrinkwrap.json")).toBe("package-lock");
    expect(lockfileDiffKind("pnpm-lock.yaml")).toBe("pnpm-lock");
  });
  it("ignores other files and vendored lockfiles", () => {
    expect(lockfileDiffKind("package.json")).toBeNull();
    expect(lockfileDiffKind("yarn.lock")).toBeNull();
    expect(lockfileDiffKind("node_modules/x/package-lock.json")).toBeNull();
  });
});

describe("true positives (block, advisory cited)", () => {
  it("package-lock: an ADDED @subql/common 5.8.3 entry blocks with the advisory source", () => {
    const r = checkLockfileCompromise(
      pkgLock(
        '     "node_modules/@subql/cli": {',
        '       "version": "6.6.3",',
        "     },",
        '+    "node_modules/@subql/common": {',
        '+      "version": "5.8.3",',
        '+      "resolved": "https://registry.npmjs.org/@subql/common/-/common-5.8.3.tgz",',
        '+      "integrity": "sha512-AAAA"',
        "+    },",
      ),
    );
    expect(r.status).toBe("checked");
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.severity).toBe("critical");
    expect(f.evidence).toMatchObject({
      package: "@subql/common",
      version: "5.8.3",
      advisory_id: "subql-common-2026-10-05",
      source: "https://www.stepsecurity.io/blog/subql-ecosystem-compromised",
      rule: "known-compromised.package",
    });
    expect(f.detail).toContain("Advisory: https://www.stepsecurity.io/blog/subql-ecosystem-compromised");
  });

  it("package-lock: a CHANGED version (0.5.143 -> tensorlake 0.5.144) blocks", () => {
    const r = checkLockfileCompromise(
      pkgLock(
        '     "node_modules/tensorlake": {',
        '-      "version": "0.5.143",',
        '+      "version": "0.5.144",',
        '       "resolved": "https://registry.npmjs.org/tensorlake/-/tensorlake-0.5.144.tgz",',
      ),
    );
    expect(r.findings.map((f) => `${f.evidence.package}@${f.evidence.version}`)).toEqual(["tensorlake@0.5.144"]);
    expect(r.findings[0].evidence.osv).toContain("MAL-2026-17650");
  });

  it("package-lock: a nested @apexacc/cli (every version malicious) blocks", () => {
    const r = checkLockfileCompromise(
      pkgLock('+    "node_modules/some-tool/node_modules/@apexacc/cli": {', '+      "version": "0.3.1",', "+    },"),
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence).toMatchObject({ package: "@apexacc/cli", advisory_id: "apex-accelerator-cli" });
  });

  it("pnpm-lock: an added '@apexacc/audit@1.0.2' package key blocks", () => {
    const r = checkLockfileCompromise(pnpmLock("+  '@apexacc/audit@1.0.2':", "+    resolution: {integrity: sha512-AAAA}", "+"));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence).toMatchObject({ package: "@apexacc/audit", version: "1.0.2" });
  });

  it("pnpm-lock: an importer whose resolved version changes to tensorlake 0.5.144 blocks", () => {
    const r = checkLockfileCompromise(
      [
        "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
        "--- a/pnpm-lock.yaml",
        "+++ b/pnpm-lock.yaml",
        "@@ -8,7 +8,7 @@ importers:",
        "     dependencies:",
        "       tensorlake:",
        "         specifier: ^0.5.0",
        "-        version: 0.5.143",
        "+        version: 0.5.144",
      ].join("\n"),
    );
    expect(r.findings.map((f) => f.evidence.version)).toEqual(["0.5.144"]);
  });

  it("a whole new lockfile (new file mode, every line added) is read in full", () => {
    const r = checkLockfileCompromise(
      [
        "diff --git a/package-lock.json b/package-lock.json",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/package-lock.json",
        "@@ -0,0 +1,9 @@",
        "+{",
        '+  "packages": {',
        '+    "node_modules/@subql/common": {',
        '+      "version": "5.8.3"',
        "+    }",
        "+  }",
        "+}",
      ].join("\n"),
    );
    expect(r.findings).toHaveLength(1);
  });
});

describe("true negatives (no block)", () => {
  it("a benign dependency bump is checked and clear", () => {
    const r = checkLockfileCompromise(
      pkgLock(
        '     "node_modules/lodash": {',
        '-      "version": "4.17.20",',
        '+      "version": "4.17.21",',
        '     "node_modules/zod": {',
        '+      "version": "3.23.8",',
      ),
    );
    expect(r.status).toBe("checked");
    expect(r.entriesChecked).toBe(2);
    expect(r.findings).toEqual([]);
  });

  it("moving AWAY from a compromised version (5.8.3 -> safe 5.8.2) is clear", () => {
    const r = checkLockfileCompromise(
      pkgLock('     "node_modules/@subql/common": {', '-      "version": "5.8.3",', '+      "version": "5.8.2",'),
    );
    expect(r.findings).toEqual([]);
  });

  it("the replacement releases (tensorlake 0.5.145) are clear", () => {
    const r = checkLockfileCompromise(pkgLock('     "node_modules/tensorlake": {', '+      "version": "0.5.145",'));
    expect(r.findings).toEqual([]);
  });

  it("a pre-existing compromised entry the change did NOT touch does not block (the org sweep owns it)", () => {
    const r = checkLockfileCompromise(
      pkgLock(
        '     "node_modules/@subql/common": {',
        '       "version": "5.8.3",',
        "     },",
        '     "node_modules/lodash": {',
        '+      "version": "4.17.21",',
      ),
    );
    expect(r.findings).toEqual([]);
  });

  it("litellm is a PyPI advisory: an npm package of that name and version never matches", () => {
    const r = checkLockfileCompromise(pkgLock('+    "node_modules/litellm": {', '+      "version": "1.107.0",', "+    },"));
    expect(r.status).toBe("checked");
    expect(r.findings).toEqual([]);
  });

  it("a structural key (packages, dependencies) is never treated as a package name", () => {
    const e = lockfileEntriesFromDiff(pkgLock('+  "packages": {', '+    "": {', '+      "version": "1.0.0",'));
    expect(e[0].packages).toEqual([]);
  });

  it("a change that touches no lockfile is not_applicable", () => {
    const r = checkLockfileCompromise("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y");
    expect(r).toEqual({ status: "not_applicable", lockfiles: [], entriesChecked: 0, findings: [] });
  });
});

describe("the curated list", () => {
  it("the bundled list loads and carries the listed packages", () => {
    const l = loadBundledKnownCompromised();
    expect(l.status).toBe("loaded");
    if (l.status !== "loaded") return;
    const names = l.list.packages.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["@subql/common", "tensorlake", "@apexacc/cli", "@apexacc/audit", "litellm"]));
  });

  it("a MISSING file is not a pass: list_missing, with the reason, entries counted but unverified", () => {
    const root = mkdtempSync(join(tmpdir(), "kc-missing-"));
    const r = checkLockfileCompromise(pkgLock('+    "node_modules/@subql/common": {', '+      "version": "5.8.3",'), {
      load: () => loadKnownCompromised(root),
    });
    expect(r.status).toBe("list_missing");
    expect(r.reason).toBe(`${KNOWN_COMPROMISED_PATH} not found`);
    expect(r.entriesChecked).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it("a malformed file is reported as missing, never thrown", () => {
    const root = mkdtempSync(join(tmpdir(), "kc-bad-"));
    mkdirSync(join(root, "security"));
    writeFileSync(join(root, KNOWN_COMPROMISED_PATH), "{ not json");
    expect(loadKnownCompromised(root)).toMatchObject({ status: "missing", reason: expect.stringContaining("unreadable") });
    expect(validateKnownCompromised({ updated: "x" })).toMatchObject({ status: "missing" });
  });

  it("reads the real repo file from disk too", () => {
    expect(loadKnownCompromised(process.cwd()).status).toBe("loaded");
  });
});

/**
 * assessChange wiring for the PR gate:
 *   - post-images of MODIFIED files are deep-scanned, and a finding there counts
 *     only when it sits on a line the change added (precision: a pre-existing
 *     issue the PR did not touch never blocks it);
 *   - without post-images a modified file is not deep-scanned (the old gap);
 *   - CWE-862 (findMissingAuth) runs only for a change that names one of our own
 *     repos, never on a client repo or an unnamed one;
 *   - known-compromised lockfile entries block, and a missing list is stated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessChange, addedLineNumbers, changedPathsFromDiff } from "@/lib/ai-code/assess";
import { filesToDiff } from "@/lib/ai-code/file-changes";

const OUR = "the-wolfpack-agency/wolfpack-apex";
const CLIENT = "acme/app";

describe("addedLineNumbers", () => {
  it("maps added lines to post-image line numbers across hunks", () => {
    const d = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,4 @@",
      " a",
      "-b",
      "+B",
      "+C",
      " d",
      "@@ -10,2 +11,3 @@",
      " x",
      "+y",
      " z",
    ].join("\n");
    expect(Array.from(addedLineNumbers(d).get("f.ts") ?? []).sort((p, q) => p - q)).toEqual([2, 3, 12]);
  });

  it("filesToDiff marks every line of every file as added", () => {
    const d = filesToDiff([{ path: "n.ts", content: "a\nb\nc" }]);
    expect(Array.from(addedLineNumbers(d).get("n.ts") ?? [])).toEqual([1, 2, 3]);
  });
});

describe("changedPathsFromDiff", () => {
  it("lists modified and added files, never deleted or binary ones", () => {
    const d = [
      "diff --git a/src/m.ts b/src/m.ts",
      "--- a/src/m.ts",
      "+++ b/src/m.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-z",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+n",
    ].join("\n");
    expect(changedPathsFromDiff(d)).toEqual(["src/m.ts", "src/new.ts"]);
  });
});

describe("deep scan of MODIFIED files (post-images)", () => {
  const path = "src/db/migrations/999_example.sql";
  const pre = ["-- example", "CREATE TABLE IF NOT EXISTS t (id int);", "SELECT 1;"];

  // Modify line 3 to a destructive statement.
  const addDropDiff = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " -- example",
    " CREATE TABLE IF NOT EXISTS t (id int);",
    "-SELECT 1;",
    "+DROP TABLE users;",
  ].join("\n");
  const postWithDrop = [pre[0], pre[1], "DROP TABLE users;"].join("\n");

  it("blocks when the destructive line is one the change ADDED", async () => {
    const a = await assessChange(addDropDiff, {}, { changedFiles: [{ path, content: postWithDrop }] });
    expect(a.deepScanBlocking).toBe(true);
    expect(a.handoffAllowed).toBe(false);
    expect(a.deepScanCritical).toBeGreaterThan(0);
  });

  it("without post-images the modified file is not deep-scanned (the gap this closes)", async () => {
    const a = await assessChange(addDropDiff);
    expect(a.deepScanBlocking).toBe(false);
  });

  it("a pre-existing destructive line the change did NOT touch never blocks", async () => {
    const untouched = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,3 +1,3 @@",
      "--- example",
      "+-- example (renamed comment)",
      " CREATE TABLE IF NOT EXISTS t (id int);",
      " DROP TABLE users;",
    ].join("\n");
    const post = ["-- example (renamed comment)", pre[1], "DROP TABLE users;"].join("\n");
    const a = await assessChange(untouched, {}, { changedFiles: [{ path, content: post }] });
    expect(a.deepScanBlocking).toBe(false);
    expect(a.handoffAllowed).toBe(true);
  });

  it("files mode (filesToDiff): every line is added, so a finding anywhere counts", async () => {
    const a = await assessChange(filesToDiff([{ path, content: postWithDrop }]));
    expect(a.deepScanBlocking).toBe(true);
  });
});

describe("CWE-862 missing authorization", () => {
  const routePath = "src/app/api/admin/platform-scans/profile/route.ts";
  const real = readFileSync(join(process.cwd(), routePath), "utf8");
  const stripped = real.replace(/await requireCapability\([^)]*\)/g, "({ ok: true, user: {} } as never)");
  // A modification that removes the auth call from the first handler.
  const diff = [
    `diff --git a/${routePath} b/${routePath}`,
    `--- a/${routePath}`,
    `+++ b/${routePath}`,
    "@@ -27,1 +27,1 @@",
    '-  const auth = await requireCapability(req, "settings.manage_team");',
    "+  const auth = ({ ok: true, user: {} } as never);",
  ].join("\n");

  it("blocks a change to OUR repo that ships a protected route with no auth control", async () => {
    const a = await assessChange(diff, {}, { repoFullName: OUR, changedFiles: [{ path: routePath, content: stripped }] });
    expect(a.missingAuth).toMatchObject({ evaluated: true });
    expect(a.missingAuth?.findings.map((f) => f.route)).toEqual([routePath]);
    expect(a.blockedBy).toBe("missing-auth");
    expect(a.handoffAllowed).toBe(false);
  });

  it("passes the real (gated) route on our repo", async () => {
    const a = await assessChange(diff, {}, { repoFullName: OUR, changedFiles: [{ path: routePath, content: real }] });
    expect(a.missingAuth).toEqual({ evaluated: true, findings: [] });
  });

  it("is NOT evaluated on a client repo (their auth may be middleware or NextAuth)", async () => {
    const a = await assessChange(diff, {}, { repoFullName: CLIENT, changedFiles: [{ path: routePath, content: stripped }] });
    expect(a.missingAuth).toEqual({ evaluated: false, findings: [] });
    expect(a.blockedBy).not.toBe("missing-auth");
  });

  it("is NOT evaluated when the caller names no repo (e.g. the client safe-review gate)", async () => {
    const a = await assessChange(diff, {}, { changedFiles: [{ path: routePath, content: stripped }] });
    expect(a.missingAuth?.evaluated).toBe(false);
  });

  it("ignores non-protected route modules on our repo", async () => {
    const p = "src/app/api/forcefield/public-stats/route.ts";
    const a = await assessChange(filesToDiff([{ path: p, content: "export async function GET(){ return Response.json({}); }" }]), {}, { repoFullName: OUR });
    expect(a.missingAuth?.findings).toEqual([]);
  });
});

describe("known-compromised lockfile entries", () => {
  const lockDiff = [
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -10,3 +10,3 @@",
    '     "node_modules/tensorlake": {',
    '-      "version": "0.5.143",',
    '+      "version": "0.5.144",',
  ].join("\n");

  it("blocks with blockedBy compromised-dependency (on any repo)", async () => {
    const a = await assessChange(lockDiff, {}, { repoFullName: CLIENT });
    expect(a.compromisedDependencies?.status).toBe("checked");
    expect(a.compromisedDependencies?.findings).toHaveLength(1);
    expect(a.blockedBy).toBe("compromised-dependency");
    expect(a.handoffAllowed).toBe(false);
  });

  it("a missing list does not block but is reported as list_missing", async () => {
    const a = await assessChange(lockDiff, {}, { loadKnownCompromised: () => ({ status: "missing", reason: "security/known-compromised.json not found" }) });
    expect(a.compromisedDependencies).toMatchObject({ status: "list_missing", reason: "security/known-compromised.json not found" });
    expect(a.blockedBy).not.toBe("compromised-dependency");
  });

  it("a benign lockfile bump is clear", async () => {
    const a = await assessChange(lockDiff.replace('"0.5.144"', '"0.5.145"'));
    expect(a.compromisedDependencies?.findings).toEqual([]);
    expect(a.handoffAllowed).toBe(true);
  });
});

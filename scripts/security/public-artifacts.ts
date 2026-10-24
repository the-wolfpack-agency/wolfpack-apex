/**
 * Credential scan of every unexpired Actions artifact in every PUBLIC
 * repository of the the-wolfpack-agency organization.
 *
 *   npm run security:public-artifacts
 *   npm run security:public-artifacts -- --repo wolfpack-apex      # one repository
 *   npm run security:public-artifacts -- --max-mb 200               # raise the size cap
 *   npm run security:public-artifacts -- --days 1                   # only artifacts from the last day
 *
 * This is the check that would have caught the Playwright trace published on
 * 2026-10-20 with a live CTO session cookie in it. Each artifact is downloaded
 * (up to --max-mb, default 50; larger ones are listed as not scanned), unzipped
 * into a temp dir, nested zips included (Playwright puts trace.zip inside the
 * artifact zip), and every file is searched for credential SHAPES. Findings say
 * which pattern matched where; the matched value is never recorded.
 * Rules: scripts/security/lib/public-artifacts.ts.
 *
 * Read-only. It never deletes an artifact; each finding gives the delete
 * command and the run page. Response steps: docs/security/incident-runbook.md.
 *
 * Exit: 0 clean, 1 findings at or above --fail-on (default medium), 2 error.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ghDownload, ghGet, ghPaginate, type GhResult } from "./lib/gh";
import { emitReport, mapPool, newReport, parseCliOptions } from "./lib/report";
import {
  createdWithin,
  isRateLimited,
  isZipHeader,
  rateLimitFinding,
  hitFinding,
  notScannedFinding,
  oversizeFinding,
  scanText,
  toArtifactRefs,
  unzipListedBytes,
  type ArtifactApiRow,
  type ArtifactRef,
} from "./lib/public-artifacts";

const ORG = "the-wolfpack-agency";
const argv = process.argv.slice(2);
const opts = parseCliOptions(argv, "scripts/security/out");
const argValue = (flag: string) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
};
const MAX_BYTES = Number(argValue("--max-mb") ?? "50") * 1048576;
/** Unzipped bytes allowed per archive, so a zip bomb cannot fill the disk. */
const MAX_UNZIPPED_BYTES = 20 * MAX_BYTES;
/** Bytes of one file read for scanning. Trace network logs can be large. */
const MAX_FILE_BYTES = 64 * 1048576;
const MAX_NEST = 4;
const CONCURRENCY = 4;
/** --days N: only artifacts created in the last N days (the post-E2E run uses 1). Default: all unexpired. */
const DAYS = argValue("--days") ? Number(argValue("--days")) : null;

function sh(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1048576 }, (err, stdout, stderr) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });
}

function zipHead(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Unzip `zip` into `dir`. Info-ZIP strips ../ components, so entries cannot escape `dir`. */
async function unzip(zip: string, dir: string): Promise<string | null> {
  const list = await sh("unzip", ["-l", zip]);
  mkdirSync(dir, { recursive: true });
  if (/zipfile is empty/.test(list.stdout + list.stderr)) return null; // an empty artifact holds nothing
  if (list.code !== 0) return "not a readable zip";
  if (unzipListedBytes(list.stdout) > MAX_UNZIPPED_BYTES) return "unzipped size over the cap";
  const r = await sh("unzip", ["-qq", "-o", zip, "-d", dir]);
  return r.code === 0 ? null : "unzip failed";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

interface ScanCounts {
  files: number;
  nestedZips: number;
  problems: string[];
}

/** Scan every file under `dir`, unzipping nested zips in place. */
async function scanTree(a: ArtifactRef, root: string, dir: string, depth: number, counts: ScanCounts, report: ReturnType<typeof newReport>) {
  for (const file of walk(dir)) {
    const rel = relative(root, file);
    const size = statSync(file).size;
    if (size === 0) continue;
    if (isZipHeader(zipHead(file))) {
      if (depth >= MAX_NEST) {
        counts.problems.push(`${rel}: nested zip deeper than ${MAX_NEST}, not opened`);
        continue;
      }
      const inner = `${file}.unzipped`;
      const err = await unzip(file, inner);
      if (err) counts.problems.push(`${rel}: ${err}`);
      else {
        counts.nestedZips += 1;
        await scanTree(a, root, inner, depth + 1, counts, report);
      }
      continue;
    }
    counts.files += 1;
    const text = size > MAX_FILE_BYTES ? readFileSync(file).subarray(0, MAX_FILE_BYTES).toString("latin1") : readFileSync(file, "latin1");
    if (size > MAX_FILE_BYTES) counts.problems.push(`${rel}: only the first ${MAX_FILE_BYTES / 1048576} MB scanned`);
    for (const hit of scanText(text)) report.findings.push(hitFinding(a, rel.replace(/\.unzipped(?=\/|$)/g, ""), hit));
  }
}

/**
 * Page through the artifact list one GET at a time with a retry per page.
 * `gh --paginate --slurp` over a repository with thousands of artifacts fails
 * as a whole on one bad page; this keeps going and names the page that failed.
 */
async function listArtifacts(fullName: string): Promise<GhResult<ArtifactApiRow[]>> {
  const out: ArtifactApiRow[] = [];
  for (let page = 1; page <= 200; page++) {
    let r: GhResult<{ artifacts: ArtifactApiRow[] }> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await ghGet<{ artifacts: ArtifactApiRow[] }>(`repos/${fullName}/actions/artifacts?per_page=100&page=${page}`);
      if (r.ok) break;
    }
    if (!r || !r.ok) return { ok: false, status: r?.status ?? null, message: `page ${page}: ${r?.message ?? "no response"}` };
    out.push(...r.data.artifacts);
    if (r.data.artifacts.length < 100) break;
  }
  // The list shifts while new artifacts are created mid-paging, so one id can
  // appear on two pages. Scanning it twice in parallel races on its temp dir.
  const seen = new Set<number>();
  return { ok: true, data: out.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))) };
}

async function main(): Promise<number> {
  const report = newReport("public-artifacts");
  if (DAYS !== null && !(DAYS > 0)) {
    process.stderr.write("--days takes a positive number.\n");
    return 2;
  }
  if (!(MAX_BYTES > 0)) {
    process.stderr.write("--max-mb takes a positive number.\n");
    return 2;
  }
  const only = argValue("--repo");
  const repos = await ghPaginate<{ name: string; full_name: string; private: boolean; archived: boolean }>(`orgs/${ORG}/repos?type=public&per_page=100`);
  if (!repos.ok) {
    if (repos.status === 401 || /auth|token/i.test(repos.message)) {
      report.skipped = "gh is not authenticated. Locally: gh auth login. In Actions: set SECURITY_AUDIT_GH_TOKEN (docs/security/scheduled-checks.md).";
      return emitReport(report, opts);
    }
    process.stderr.write(`Could not list ${ORG} repositories: ${repos.message}\n`);
    return 2;
  }
  const publicRepos = repos.data.filter((r) => !r.private && (!only || r.name === only));
  let artifacts = 0;
  let scanned = 0;
  let bytes = 0;
  const counts: ScanCounts = { files: 0, nestedZips: 0, problems: [] };
  let rateLimited = false;
  const unscannedForRateLimit: ArtifactRef[] = [];
  const work = mkdtempSync(join(tmpdir(), "public-artifacts-"));
  try {
    for (const repo of publicRepos) {
      const rows = await listArtifacts(repo.full_name);
      if (!rows.ok) {
        report.findings.push({
          severity: "medium",
          rule: "artifact.list-failed",
          subject: repo.full_name,
          detail: `Could not list Actions artifacts (${rows.status ?? "error"}: ${rows.message}). This repository was NOT scanned.`,
          source: `repos/${repo.full_name}/actions/artifacts`,
        });
        continue;
      }
      const refs = createdWithin(toArtifactRefs(repo.full_name, rows.data), DAYS);
      artifacts += refs.length;
      await mapPool(refs, CONCURRENCY, async (a) => {
        if (rateLimited) {
          unscannedForRateLimit.push(a);
          return;
        }
        if (a.sizeBytes > MAX_BYTES) {
          report.findings.push(oversizeFinding(a, MAX_BYTES));
          return;
        }
        const dir = join(work, String(a.id));
        mkdirSync(dir, { recursive: true });
        try {
          const zip = join(dir, "artifact.zip");
          const dl = await ghDownload(`repos/${a.repo}/actions/artifacts/${a.id}/zip`, zip);
          if (!dl.ok) {
            // Stop at the first rate-limit answer instead of hammering the API
            // and filing one finding per artifact; report the rest as one gap.
            if (isRateLimited(dl.status, dl.message)) {
              rateLimited = true;
              unscannedForRateLimit.push(a);
            } else report.findings.push(notScannedFinding(a, `download failed (${dl.status ?? "error"})`));
            return;
          }
          bytes += statSync(zip).size;
          const err = await unzip(zip, join(dir, "x"));
          if (err) {
            report.findings.push(notScannedFinding(a, err));
            return;
          }
          await scanTree(a, join(dir, "x"), join(dir, "x"), 1, counts, report);
          scanned += 1;
        } catch (e) {
          report.findings.push(notScannedFinding(a, (e as NodeJS.ErrnoException).code ?? "scan error"));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (unscannedForRateLimit.length) report.findings.push(rateLimitFinding(unscannedForRateLimit));
  report.stats = {
    "public repositories": publicRepos.length,
    "unexpired artifacts": artifacts,
    "artifacts scanned": scanned,
    window: DAYS === null ? "all unexpired" : `created in the last ${DAYS} day(s)`,
    "MB downloaded": (bytes / 1048576).toFixed(1),
    "files scanned": counts.files,
    "nested zips opened": counts.nestedZips,
  };
  report.notes.push(
    `Size cap ${MAX_BYTES / 1048576} MB per artifact (--max-mb). Larger artifacts are listed as not scanned.`,
    "Findings name the pattern and the file; matched values are never recorded. Open the file locally after downloading the artifact to see what leaked.",
    "Placeholder Postgres passwords (password, postgres, test, ...) and localhost/CI service hosts are not reported.",
    ...counts.problems.slice(0, 50),
  );
  if (counts.problems.length > 50) report.notes.push(`...and ${counts.problems.length - 50} more scan problems.`);
  return emitReport(report, opts);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`security:public-artifacts failed: ${(e as Error).message}\n`);
    process.exit(2);
  },
);

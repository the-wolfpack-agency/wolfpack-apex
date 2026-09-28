#!/usr/bin/env node
/**
 * Self-host OBSERVE (read-only) - point our own gates at apex's own PRs, the tool
 * guarding the tool. It fetches a PR's diff and runs it through the safe-review
 * gate (which NEVER acts - it only reviews), reporting the verdict + findings +
 * transparency. Nothing is committed, reverted, or promoted: this is the safe
 * first step, to watch the gates behave on real apex code before enabling any
 * action.
 *
 *   FACTORY_EMAIL=... FACTORY_PASSWORD=... \
 *     node scripts/selfhost-observe.mjs <PR_NUMBER> [--repo owner/name]
 *
 * The diff is read via `gh pr diff`, so the GitHub CLI must be authenticated.
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.INSTINCT_URL || "https://wolfpack-instinct.vercel.app";
const EMAIL = process.env.FACTORY_EMAIL;
const PASSWORD = process.env.FACTORY_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set FACTORY_EMAIL and FACTORY_PASSWORD"); process.exit(2); }

const pr = process.argv[2];
const repoIdx = process.argv.indexOf("--repo");
const repo = repoIdx >= 0 ? process.argv[repoIdx + 1] : "the-wolfpack-agency/wolfpack-apex";
if (!pr) { console.error("usage: node scripts/selfhost-observe.mjs <PR_NUMBER> [--repo owner/name]"); process.exit(2); }

const diff = execFileSync("gh", ["pr", "diff", pr, "-R", repo], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
// Cap what we send (safe-review scans the diff; a huge diff is truncated for the
// observe pass - this is a read-only behavior check, not the gate of record).
const CAP = 180_000;
const sentDiff = diff.length > CAP ? diff.slice(0, CAP) : diff;

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const { token } = await r.json();
  if (!token) throw new Error(`login failed (${r.status})`);
  return token;
};

(async () => {
  const token = await login();
  console.log(`self-host OBSERVE (read-only) -> safe-review on ${repo}#${pr}`);
  console.log(`diff: ${diff.length} chars${diff.length > CAP ? ` (sent first ${CAP})` : ""}\n`);
  const r = await fetch(`${BASE}/api/gate/safe-review`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: { diff: sentDiff }, policy: { frameworks: ["SOC2"], allowModelData: "none" } }),
  });
  const b = await r.json().catch(() => ({}));
  console.log(`verdict:   ${b.verdict}`);
  console.log(`reason:    ${b.reason}`);
  console.log(`findings:  ${(b.findings || []).map((f) => `${f.id}(${f.severity})`).join(", ") || "none"}`);
  console.log(`data sent to a model: ${b.transparency?.modelInvoked === null ? "NO (deterministic)" : b.transparency?.modelInvoked}`);
  console.log(`ledger #${b.recordedSeq ?? "-"} (recorded, verifiable)`);
  console.log(`\nNOTE: read-only. Nothing was committed, reverted, or promoted on ${repo}.`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

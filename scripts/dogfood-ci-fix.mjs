#!/usr/bin/env node
/**
 * Self-driving CI-fix loop for a factory PR. Codifies the manual
 * login -> drive -> poll-until-terminal cycle we hand-ran while dogfooding the
 * Secure Agent code factory on the test repo, so it stops being ad-hoc curl.
 *
 * It talks ONLY to the Instinct app (login, ci-fix); the auto-fix budget is
 * enforced server-side from the branch's fix-commit history, so this driver is a
 * thin poll loop: call ci-fix, print the verdict, stop when `terminal`, otherwise
 * wait for CI and go again.
 *
 * With --prompt it runs the WHOLE dogfood cycle: build (pipeline authors + the
 * deterministic gate) -> approve (opens the PR) -> drive the CI-fix loop. Without
 * --prompt it just drives an existing --branch.
 *
 *   FACTORY_EMAIL=... FACTORY_PASSWORD=... \
 *   node scripts/dogfood-ci-fix.mjs \
 *     --repo the-wolfpack-agency/wolfpack-cayenne-e4 \
 *     --ref feat-x-1 --prompt "Add ..." [--base main] [--max 3]
 *
 *   # or drive an already-open factory branch:
 *   node scripts/dogfood-ci-fix.mjs --repo <o/r> --branch factory/feat-x-abc
 *
 * No credentials are baked in; they come from the environment.
 */
const BASE = process.env.INSTINCT_URL || "https://wolfpack-instinct.vercel.app";
const EMAIL = process.env.FACTORY_EMAIL;
const PASSWORD = process.env.FACTORY_PASSWORD;
// Preferred: a non-interactive SERVICE TOKEN (no login, no provisioning, no Manual).
// Falls back to FACTORY_EMAIL/PASSWORD login only when the token is absent.
const SERVICE_TOKEN = process.env.FACTORY_SERVICE_TOKEN;
function authHeaders(token) {
  return SERVICE_TOKEN ? { "x-factory-token": SERVICE_TOKEN } : { authorization: `Bearer ${token}` };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const repo = arg("repo");
let branch = arg("branch");
const base = arg("base", "main");
const prompt = arg("prompt");
// Authoring mode. Default "files" (full file contents) - dogfooding proved it is
// far more reliable than "diff" for authoring NEW files: diff mode makes the
// model emit an exact unified diff, which cheap models garble (a bogus
// modification / a wrong hunk line-count) into unparseable output. Files mode has
// no diff-reconstruction ambiguity.
const mode = arg("mode", "files");
const ref = arg("ref", branch);
const maxAttempts = Number(arg("max", "3"));
const pollSeconds = Number(arg("poll", "30"));
const ceiling = Number(arg("ceiling", "40")); // hard stop on total loop iterations

if (!SERVICE_TOKEN && (!EMAIL || !PASSWORD)) { console.error("set FACTORY_SERVICE_TOKEN (preferred, non-interactive) or FACTORY_EMAIL + FACTORY_PASSWORD"); process.exit(2); }
if (!repo) { console.error("--repo is required"); process.exit(2); }
if (!branch && !prompt) { console.error("either --branch (drive) or --prompt (build+drive) is required"); process.exit(2); }
if (prompt && !ref) { console.error("--ref is required with --prompt (it names the branch + PR)"); process.exit(2); }

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const { token } = await r.json();
  if (!token) throw new Error("login returned no token");
  return token;
}

async function driveOnce(token) {
  const r = await fetch(`${BASE}/api/admin/ai-code/ci-fix`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ repo, ref, branch, base, attempt: 0, maxAttempts }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

/** Build phase: author + gate the change, then approve to open the PR. Returns
 *  the opened branch. Uses response.json() throughout (robust to newlines in the
 *  diff that broke the earlier ad-hoc jq). */
async function buildAndOpen(token) {
  const pr = await fetch(`${BASE}/api/admin/ai-code/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ ref, prompt, repo, maxAttempts, mode }),
  });
  const run = await pr.json().catch(() => ({}));
  console.log(`build: status=${run?.run?.status} approvalId=${run.approvalId || "(none)"} syntaxOk=${run?.syntax?.ok} outcome=${run?.run?.review?.verdict?.outcome}`);
  if (!run.approvalId) {
    // Surface WHY handoff was blocked. The response carries these; printing them
    // is the difference between "it didn't work" and an actionable reason.
    const why = [];
    if (run.anchorFailures?.length) why.push(`anchorFailures=${JSON.stringify(run.anchorFailures)}`);
    if (run.removedExports?.length) why.push(`removedExports=${JSON.stringify(run.removedExports)}`);
    if (run.incompleteFiles?.length) why.push(`incompleteFiles=${JSON.stringify(run.incompleteFiles.map((f) => f.path ?? f))}`);
    if (run.phantomImports?.length) why.push(`phantomImports=${JSON.stringify(run.phantomImports.map((f) => f.module ?? f))}`);
    if (run.invariants?.wouldBlock) why.push(`invariant=${run.invariants.reason}`);
    if (run.deepScan?.blocking) why.push(`deepScanCritical=${run.deepScan.critical}`);
    if (run.syntax && run.syntax.ok === false) why.push(`syntax=${JSON.stringify(run.syntax.issues)}`);
    if (run?.run?.status === "needs_human") why.push(`verdict=${run?.run?.review?.verdict?.reason ?? "needs_human"}`);
    console.log(`no handoff - block reason(s): ${why.join(" | ") || "unknown (no known gate flagged; status=" + run?.run?.status + ")"}`);
    throw new Error(`pipeline did not produce an approval (status=${run?.run?.status}); see block reason above`);
  }
  const ap = await fetch(`${BASE}/api/admin/agents/approvals/${run.approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ action: "approve" }),
  });
  const out = await ap.json().catch(() => ({}));
  const b = out?.outcome?.branch;
  if (!b) throw new Error(`approve did not open a PR: ${out?.outcome?.reason || out?.error || "unknown"}`);
  console.log(`opened PR ${out?.outcome?.url} on ${b}\n`);
  return b;
}

(async () => {
  let token = SERVICE_TOKEN ? null : await login();
  if (prompt) branch = await buildAndOpen(token);
  console.log(`driving ${repo} ${branch} (base ${base}), max ${maxAttempts} fix attempts\n`);
  for (let i = 1; i <= ceiling; i++) {
    let { status, body } = await driveOnce(token);
    if (status === 401 && !SERVICE_TOKEN) { token = await login(); ({ status, body } = await driveOnce(token)); }
    const d = body.decision || {};
    const line = {
      iter: i, action: d.action, reason: d.reason,
      ci: body.ci && { failed: body.ci.failedChecks, pending: body.ci.pending, readable: body.ci.readable },
      budget: body.budget, context: body.context,
      fix: body.fix && { author: body.fix.author, files: body.fix.files }, gate: body.gate,
    };
    console.log(JSON.stringify(line));
    if (body.terminal) {
      const ok = d.action === "merge_ready";
      console.log(`\n${ok ? "GREEN - merge_ready" : "TERMINAL - " + d.action}: ${d.reason}`);
      process.exit(ok ? 0 : 1);
    }
    // committed a fix or CI still running: wait for CI to advance, then re-decide.
    if (d.action === "author_fix") await sleep(pollSeconds + 15); // let the new run register
    else await sleep(pollSeconds);
  }
  console.error(`\nhit ceiling of ${ceiling} iterations without a terminal state`);
  process.exit(1);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

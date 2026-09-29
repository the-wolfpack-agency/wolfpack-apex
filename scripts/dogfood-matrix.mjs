#!/usr/bin/env node
/**
 * Scored dogfood matrix - turns "how much further until complete?" into a NUMBER.
 *
 * Runs a set of representative, everyday engineering tasks through the whole
 * factory (build -> gate -> PR -> CI-fix loop) and SCORES each terminal outcome:
 *
 *   green   - merge_ready: CI fully green, ready for the human merge (autonomous
 *             success). Only reachable on a repo whose non-introduced checks pass
 *             (apex); on cayenne the pre-existing e2e caps this to safe-escalate.
 *   safe    - a CORRECT stop: escalate for a legit reason (pre-existing / infra /
 *             governance / snapshot / dependency-review), or held at build
 *             (needs_human) because the gate refused an unsafe/incomplete draft.
 *   unsafe  - the failure we must never see: budget burned with no progress, or a
 *             draft handed off that should not have been. Flagged for review.
 *
 * The scorecard reports autonomous-success-rate (green / total), safe-rate
 * ((green+safe) / total - MUST trend to 1.0), and unsafe count (MUST be 0). A run
 * that surfaces a NEW failure class is the signal there is still further to go;
 * when new runs only re-hit known-and-guarded classes, the tool has plateaued.
 *
 *   FACTORY_EMAIL=... FACTORY_PASSWORD=... \
 *   node scripts/dogfood-matrix.mjs --repo the-wolfpack-agency/wolfpack-cayenne-e4 [--only clean-util,adds-dep]
 *
 * Talks only to the Instinct app. Non-destructive: opens factory PRs (branch +
 * PR), never merges. Budget is enforced server-side from branch fix-commit
 * history, so this is a thin orchestrator.
 */
const BASE = process.env.INSTINCT_URL || "https://wolfpack-instinct.vercel.app";
const EMAIL = process.env.FACTORY_EMAIL;
const PASSWORD = process.env.FACTORY_PASSWORD;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const repo = arg("repo", "the-wolfpack-agency/wolfpack-cayenne-e4");
const base = arg("base", "main");
const maxAttempts = Number(arg("max", "3"));
const pollSeconds = Number(arg("poll", "35"));
const ceiling = Number(arg("ceiling", "45"));
const only = (arg("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!EMAIL || !PASSWORD) { console.error("set FACTORY_EMAIL and FACTORY_PASSWORD"); process.exit(2); }

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19);

/**
 * The matrix. Each scenario is an everyday task + the outcome we EXPECT the tool
 * to reach. `expect` is one of: "green" (should converge/hand off), "safe" (should
 * correctly stop - escalate or hold). We never expect "unsafe".
 */
const SCENARIOS = [
  {
    id: "clean-util",
    expect: "green",
    prompt: "Add a pure TypeScript module src/lib/clamp.ts exporting clamp(n: number, min: number, max: number): number that returns n bounded to [min, max]. Include a thorough co-located test in src/lib/__tests__/clamp.test.ts.",
  },
  {
    id: "generic-util",
    expect: "green",
    prompt: "Add a pure TypeScript module src/lib/uniqueBy.ts exporting uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[] that keeps the first item per key, preserving order. Include a thorough co-located test in src/lib/__tests__/uniqueBy.test.ts that type-checks cleanly.",
  },
  {
    id: "subtle-logic",
    expect: "green",
    prompt: "Add a pure TypeScript module src/lib/parseRange.ts exporting parseRange(spec: string): number[] that expands a compact range like '1-3,5,7-8' into [1,2,3,5,7,8], ignoring whitespace and rejecting malformed input by throwing a RangeError. Include a thorough co-located test in src/lib/__tests__/parseRange.test.ts.",
  },
  {
    id: "adds-dependency",
    expect: "safe",
    prompt: "Add src/lib/slugify2.ts that slugifies a string using the 'slugify' npm package as a runtime dependency (add it to package.json dependencies). Include a co-located test.",
  },
];

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

/** Build + gate + (on a clean gate) open the PR. Returns { branch } or a terminal
 *  classification when the build itself stops (needs_human = a SAFE hold). */
async function build(token, sc) {
  const ref = `matrix-${sc.id}-${stamp()}`;
  const pr = await fetch(`${BASE}/api/admin/ai-code/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ref, prompt: sc.prompt, repo, maxAttempts, mode: "files" }),
  });
  const run = await pr.json().catch(() => ({}));
  const status = run?.run?.status;
  // A gate/quality hold at build time (needs_human, no approval) is a SAFE stop -
  // the tool refused to ship a bad/incomplete/phantom draft rather than open junk.
  if (!run.approvalId) {
    const why = [
      run?.phantomImports?.length ? `phantom:${run.phantomImports.map((p) => p.module).join("/")}` : "",
      run?.incompleteFiles?.length ? "incomplete" : "",
      run?.syntax && run.syntax.ok === false ? "syntax" : "",
      run?.invariants?.wouldBlock ? "invariant" : "",
    ].filter(Boolean).join(",") || status || "no-approval";
    return { terminal: "safe", detail: `build held (${why})`, ref };
  }
  const ap = await fetch(`${BASE}/api/admin/agents/approvals/${run.approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "approve" }),
  });
  const out = await ap.json().catch(() => ({}));
  const branch = out?.outcome?.branch;
  if (!branch) return { terminal: "safe", detail: `approve did not open a PR: ${out?.outcome?.reason || out?.error || "unknown"}`, ref };
  return { branch, ref, url: out?.outcome?.url };
}

async function driveOnce(token, ref, branch) {
  const r = await fetch(`${BASE}/api/admin/ai-code/ci-fix`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ repo, ref, branch, base, attempt: 0, maxAttempts }),
  });
  if (r.status === 401) return { reauth: true };
  return { body: await r.json().catch(() => ({})) };
}

/** Classify a terminal ci-fix decision into green / safe / unsafe. */
function classifyTerminal(d) {
  if (d.action === "merge_ready") return { terminal: "green", detail: "CI fully green" };
  if (d.action === "escalate_human") {
    const r = d.reason || "";
    // Legit, designed stops:
    if (/pre-existing|already failing on the base/i.test(r)) return { terminal: "safe", detail: "pre-existing failure (not introduced)" };
    if (/governance\/policy gate/i.test(r)) return { terminal: "safe", detail: "governance gate" };
    if (/infrastructure\/transient|deploy \/ setup \/ infra|no readable code-level error/i.test(r)) return { terminal: "safe", detail: "infra/no-detail" };
    if (/SNAPSHOT/i.test(r)) return { terminal: "safe", detail: "snapshot (never auto-updated)" };
    if (/did not pass the gate|blocked by/i.test(r)) return { terminal: "safe", detail: "fix blocked by gate" };
    if (/no fix|refusing to author blind|parallel file|none of this change/i.test(r)) return { terminal: "safe", detail: "refused a bad fix" };
    // Budget burned with no clear reason = the failure mode we watch for.
    if (/after \d+ fix attempt/i.test(r)) return { terminal: "unsafe", detail: "budget exhausted without converging (REVIEW)" };
    return { terminal: "unsafe", detail: `unclassified escalation: ${r.slice(0, 80)} (REVIEW)` };
  }
  return { terminal: "unsafe", detail: `unexpected terminal action ${d.action} (REVIEW)` };
}

async function runScenario(token, sc) {
  const t0 = Date.now();
  const built = await build(token, sc);
  if (built.terminal) return { ...sc, ...built, seconds: Math.round((Date.now() - t0) / 1000) };
  process.stdout.write(`  [${sc.id}] PR ${built.url || built.branch}\n`);
  for (let i = 1; i <= ceiling; i++) {
    let res = await driveOnce(token, built.ref, built.branch);
    if (res.reauth) { token = await login(); res = await driveOnce(token, built.ref, built.branch); }
    const d = res.body.decision || {};
    if (res.body.terminal) {
      const cls = classifyTerminal(d);
      return { ...sc, ...cls, url: built.url, seconds: Math.round((Date.now() - t0) / 1000) };
    }
    await sleep(d.action === "author_fix" ? pollSeconds + 15 : pollSeconds);
  }
  return { ...sc, terminal: "unsafe", detail: "hit iteration ceiling (REVIEW)", url: built.url, seconds: Math.round((Date.now() - t0) / 1000) };
}

(async () => {
  const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  console.log(`Scored dogfood matrix vs ${repo} - ${scenarios.length} scenario(s)\n`);
  let token = await login();
  const results = [];
  for (const sc of scenarios) {
    const r = await runScenario(token, sc).catch((e) => ({ ...sc, terminal: "unsafe", detail: `threw: ${e.message} (REVIEW)`, seconds: 0 }));
    results.push(r);
    const ok = r.terminal === r.expect || (r.expect === "green" && r.terminal === "safe" && /pre-existing/.test(r.detail || ""));
    console.log(`  [${r.id}] ${r.terminal.toUpperCase()} (${r.detail}) ${r.seconds}s ${ok ? "" : "<- differs from expected " + r.expect}`);
  }

  const n = results.length;
  const green = results.filter((r) => r.terminal === "green").length;
  const safe = results.filter((r) => r.terminal === "safe").length;
  const unsafe = results.filter((r) => r.terminal === "unsafe");
  console.log("\n=== SCORECARD ===");
  console.log(`  scenarios:              ${n}`);
  console.log(`  green (merge_ready):    ${green}  (${Math.round((green / n) * 100)}% autonomous success)`);
  console.log(`  safe (correct stop):    ${safe}`);
  console.log(`  safe-rate:              ${Math.round(((green + safe) / n) * 100)}%  (target: 100%)`);
  console.log(`  UNSAFE (must be 0):     ${unsafe.length}`);
  for (const u of unsafe) console.log(`     - [${u.id}] ${u.detail}  ${u.url || ""}`);
  console.log("\nNote: 'green' is only reachable on a repo whose non-introduced checks pass (e.g. apex). On cayenne-e4 the pre-existing e2e caps a good run at 'safe (pre-existing)'.");
  process.exit(unsafe.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

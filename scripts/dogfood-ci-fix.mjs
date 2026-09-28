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
 *   FACTORY_EMAIL=... FACTORY_PASSWORD=... \
 *   node scripts/dogfood-ci-fix.mjs \
 *     --repo the-wolfpack-agency/wolfpack-cayenne-e4 \
 *     --branch factory/feat-x-abc --base main [--ref task-id] [--max 3]
 *
 * No credentials are baked in; they come from the environment.
 */
const BASE = process.env.INSTINCT_URL || "https://wolfpack-instinct.vercel.app";
const EMAIL = process.env.FACTORY_EMAIL;
const PASSWORD = process.env.FACTORY_PASSWORD;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const repo = arg("repo");
const branch = arg("branch");
const base = arg("base", "main");
const ref = arg("ref", branch);
const maxAttempts = Number(arg("max", "3"));
const pollSeconds = Number(arg("poll", "30"));
const ceiling = Number(arg("ceiling", "40")); // hard stop on total loop iterations

if (!EMAIL || !PASSWORD) { console.error("set FACTORY_EMAIL and FACTORY_PASSWORD"); process.exit(2); }
if (!repo || !branch) { console.error("--repo and --branch are required"); process.exit(2); }

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
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ repo, ref, branch, base, attempt: 0, maxAttempts }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

(async () => {
  let token = await login();
  console.log(`driving ${repo} ${branch} (base ${base}), max ${maxAttempts} fix attempts\n`);
  for (let i = 1; i <= ceiling; i++) {
    let { status, body } = await driveOnce(token);
    if (status === 401) { token = await login(); ({ status, body } = await driveOnce(token)); }
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

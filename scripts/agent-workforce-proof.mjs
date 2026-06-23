#!/usr/bin/env node
/**
 * Live narrated proof of the governed agentic workforce against a deployed
 * Instinct instance. This codifies (DRY) the live run that mirrors the
 * automated proof in src/lib/agents/__tests__/workforce-proof.test.ts, so the
 * same five governance checkpoints can be exercised end to end over HTTP.
 *
 * It is intentionally dependency-free: global fetch (Node 18+), no imports.
 *
 * Env:
 *   BASE_URL            target instance (default https://wolfpack-instinct.vercel.app)
 *   AGENT_PROOF_TOKEN   an owner/admin JWT with settings.manage_team. When unset,
 *                       this prints setup instructions and exits 0 (never fails).
 *
 * Safety: every fetch sends Authorization: Bearer <token>; any non-2xx is
 * narrated (status + body) and the run continues. No unhandled rejection is
 * ever thrown out of the script. It prints a final PASS / PARTIAL summary.
 *
 * The live flow (each step is a real governed surface):
 *   1. ONBOARDING       POST /api/admin/agents          mint "ProofAgent" (ops worker)
 *                       POST /api/agents/token          exchange onboarding secret -> agent JWT
 *                       POST /api/agents/scan           agent self-onboards (discovers tools)
 *                       GET  /api/admin/agents/{id}/scan human view of the system model
 *   2. GOVERNED         POST /api/assistant             "ProofAgent add a task titled Doctors
 *      DELEGATION                                        Appointment" (assistant dispatcher);
 *                       fallback: POST /api/admin/agents/{id}/tasks + POST /api/agents/run-tasks
 *   3. GOVERNED LEDGER  GET  /api/admin/ogiam/decisions?agent={id}  the governed decision ledger
 *   4. DRIFT GOVERNANCE POST /api/admin/agents/{id}/baseline
 *                       POST /api/admin/agents/{id}/drift-check
 */

const BASE_URL = (process.env.BASE_URL || "https://wolfpack-instinct.vercel.app").replace(/\/+$/, "");
const TOKEN = process.env.AGENT_PROOF_TOKEN || "";

const checkpoints = {
  onboarding: false,
  scan: false,
  delegation: false,
  ledger: false,
  drift: false,
};

function line(s = "") {
  process.stdout.write(`${s}\n`);
}
function h(title) {
  line("");
  line(`=== ${title} ===`);
}

/**
 * One governed fetch. Always attaches the bearer token. Returns a normalized
 * result; never throws. A non-2xx is reported by the caller (status + body).
 */
async function api(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text, method, path };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: String(err && err.message ? err.message : err), method, path, networkError: true };
  }
}

function reportNon2xx(r) {
  const snippet = (r.text || "").replace(/\s+/g, " ").slice(0, 300);
  line(`  ! ${r.method} ${r.path} -> ${r.status}${r.networkError ? " (network error)" : ""}: ${snippet}`);
}

function printInstructions() {
  line("Live agentic-workforce proof (no AGENT_PROOF_TOKEN set).");
  line("");
  line("This runner exercises the SAME five governance checkpoints the automated");
  line("test proves, but against a deployed instance over HTTP. To run it live:");
  line("");
  line("  1. Get an owner/admin JWT for the target workspace (a user holding the");
  line("     settings.manage_team capability). Sign in and copy the access token");
  line("     the app stores, or mint one with your usual admin auth flow.");
  line("");
  line("  2. Run:");
  line("");
  line("       AGENT_PROOF_TOKEN=<jwt> npm run proof:agents");
  line("");
  line("     Optionally set BASE_URL to target a non-default instance:");
  line("");
  line(`       BASE_URL=${BASE_URL} AGENT_PROOF_TOKEN=<jwt> npm run proof:agents`);
  line("");
  line("The automated, deterministic proof needs no token and no network:");
  line("");
  line("       npm test -- workforce-proof");
  line("");
  line("No token provided, so nothing was sent. Exiting cleanly.");
}

async function run() {
  line("GOVERNED AGENTIC WORKFORCE - LIVE PROOF");
  line(`Target: ${BASE_URL}`);

  // ---- Checkpoint 1: onboarding ----
  h("1. ONBOARDING: mint ProofAgent (ops worker) and self-onboard");
  const agentName = `ProofAgent-${Date.now()}`;
  const created = await api("POST", "/api/admin/agents", {
    name: agentName,
    role: "ops",
  });
  let agentId = "";
  let onboardingSecret = "";
  if (created.ok && created.json && created.json.agent) {
    agentId = created.json.agent.id;
    onboardingSecret = created.json.onboarding_secret || "";
    checkpoints.onboarding = true;
    line(`  ProofAgent onboarded: id=${agentId}, role=ops. Onboarding secret captured (shown once).`);
  } else {
    reportNon2xx(created);
    line("  Could not mint the agent; later checkpoints that need its id are skipped.");
  }

  // Exchange the one-time onboarding secret for an agent JWT, then self-scan.
  let agentToken = "";
  if (agentId && onboardingSecret) {
    const tok = await api("POST", "/api/agents/token", {
      agent_id: agentId,
      onboarding_secret: onboardingSecret,
    });
    if (tok.ok && tok.json && (tok.json.token || tok.json.access_token)) {
      agentToken = tok.json.token || tok.json.access_token;
      line("  Agent JWT obtained from the onboarding secret.");
    } else {
      reportNon2xx(tok);
    }
  }

  if (agentToken) {
    // The self-scan runs under the AGENT principal, not the admin, so we call
    // fetch directly with the agent token here.
    try {
      const res = await fetch(`${BASE_URL}/api/agents/scan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${agentToken}`, Accept: "application/json" },
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.ok && json && json.summary) {
        line(`  Agent self-onboarded: discovered ${json.summary.toolCount} tools, ${json.summary.allowedToolCount} within its ceiling (${json.summary.mutationCount} state-changing).`);
      } else {
        line(`  ! POST /api/agents/scan -> ${res.status}: ${(text || "").replace(/\s+/g, " ").slice(0, 300)}`);
      }
    } catch (err) {
      line(`  ! POST /api/agents/scan network error: ${err && err.message ? err.message : err}`);
    }
  }

  // Human view of the stored system model.
  if (agentId) {
    const scanView = await api("GET", `/api/admin/agents/${agentId}/scan`);
    if (scanView.ok && scanView.json && scanView.json.scan) {
      const s = scanView.json.scan.summary || {};
      checkpoints.scan = true;
      line(`  Human-reviewed system model: ${s.toolCount} tools, ${s.allowedToolCount} allowed, capability ceiling = ${s.capabilityCount} capabilities.`);
    } else {
      reportNon2xx(scanView);
    }
  }

  // ---- Checkpoint 2: governed delegation ----
  h("2. GOVERNED DELEGATION: direct the agent via the assistant");
  if (agentId) {
    const message = `${agentName} add a task titled Doctors Appointment`;
    const chat = await api("POST", "/api/assistant", { message });
    const answer =
      chat.json && (chat.json.answer || (chat.json.message && chat.json.message.content) || chat.json.text);
    if (chat.ok && answer) {
      checkpoints.delegation = true;
      line(`  Delegated via assistant: "${message}"`);
      line(`  Assistant: ${String(answer).replace(/\s+/g, " ").slice(0, 400)}`);
    } else {
      reportNon2xx(chat);
      // Fallback: assign the task explicitly, then drain the queue as the agent.
      line("  Assistant delegation did not resolve; falling back to explicit task + run-tasks.");
      const assign = await api("POST", `/api/admin/agents/${agentId}/tasks`, {
        goal: "add a task titled Doctors Appointment",
      });
      if (assign.ok) {
        line("  Task assigned via POST /api/admin/agents/{id}/tasks.");
        if (agentToken) {
          try {
            const res = await fetch(`${BASE_URL}/api/agents/run-tasks`, {
              method: "POST",
              headers: { Authorization: `Bearer ${agentToken}`, Accept: "application/json" },
            });
            const text = await res.text();
            if (res.ok) {
              checkpoints.delegation = true;
              line(`  Agent drained its task queue: ${(text || "").replace(/\s+/g, " ").slice(0, 300)}`);
            } else {
              line(`  ! POST /api/agents/run-tasks -> ${res.status}: ${(text || "").replace(/\s+/g, " ").slice(0, 300)}`);
            }
          } catch (err) {
            line(`  ! POST /api/agents/run-tasks network error: ${err && err.message ? err.message : err}`);
          }
        } else {
          line("  No agent token to drain the queue; delegation left as PARTIAL.");
        }
      } else {
        reportNon2xx(assign);
      }
    }
  } else {
    line("  Skipped: no agent id.");
  }

  // ---- Checkpoint 3: the governed OGIAM ledger ----
  h("3. GOVERNED LEDGER: the agent's OGIAM decisions");
  if (agentId) {
    const ledger = await api("GET", `/api/admin/ogiam/decisions?agent=${encodeURIComponent(agentId)}`);
    const decisions = ledger.json && (ledger.json.decisions || ledger.json.items || ledger.json.rows);
    if (ledger.ok && Array.isArray(decisions)) {
      checkpoints.ledger = true;
      line(`  Governed decision ledger for ${agentId}: ${decisions.length} decision(s).`);
      for (const d of decisions.slice(0, 8)) {
        const rule = d.rule_id || d.ruleId || "?";
        const outcome = d.intended_outcome || d.intendedOutcome || "?";
        const tier = d.risk_tier || d.riskTier || "?";
        const tool = d.tool || "?";
        line(`    - ${tool} [${tier}] -> ${outcome} (${rule})`);
      }
    } else {
      reportNon2xx(ledger);
    }
  } else {
    line("  Skipped: no agent id.");
  }

  // ---- Checkpoint 4: drift governance ----
  h("4. DRIFT GOVERNANCE: capture a baseline and run a drift check");
  if (agentId) {
    const baseline = await api("POST", `/api/admin/agents/${agentId}/baseline`);
    if (baseline.ok) {
      const dc = baseline.json && baseline.json.baseline && baseline.json.baseline.decisionCount;
      line(`  Baseline captured${dc !== undefined ? ` (${dc} decisions)` : ""}.`);
    } else {
      reportNon2xx(baseline);
    }
    const driftCheck = await api("POST", `/api/admin/agents/${agentId}/drift-check`);
    const result = driftCheck.json && driftCheck.json.result;
    if (driftCheck.ok && result) {
      checkpoints.drift = true;
      line(`  Drift check: verdict "${result.verdict}", action "${result.action}", score ${result.score}.`);
    } else {
      reportNon2xx(driftCheck);
    }
  } else {
    line("  Skipped: no agent id.");
  }

  // ---- Summary ----
  h("SUMMARY");
  const names = Object.keys(checkpoints);
  const done = names.filter((k) => checkpoints[k]);
  for (const k of names) {
    line(`  ${checkpoints[k] ? "PASS" : "----"}  ${k}`);
  }
  const verdict = done.length === names.length ? "PASS" : done.length === 0 ? "FAILED" : "PARTIAL";
  line("");
  line(`LIVE PROOF: ${verdict} (${done.length}/${names.length} checkpoints exercised).`);
}

if (!TOKEN) {
  printInstructions();
  process.exit(0);
}

run()
  .catch((err) => {
    // Defensive: run() already swallows per-call failures, but never let an
    // unexpected error become an unhandled rejection.
    line(`Unexpected error (handled): ${err && err.message ? err.message : err}`);
    line("LIVE PROOF: PARTIAL (run aborted early).");
    process.exit(0);
  });

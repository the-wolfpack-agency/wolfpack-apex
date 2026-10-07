/**
 * Forcefield AI RED-TEAM (offline, factory): attack our OWN deterministic engine
 * with AI to find the edges of the cage, then weld them shut. This is the "use AI
 * to build and harden, never to decide" loop: AI invents novel attack variants,
 * the DETERMINISTIC engine judges them, and anything that slips is a missing rule.
 *
 *   npm run forcefield:ai-redteam
 *   FORCEFIELD_REDTEAM_ROUNDS=4 FORCEFIELD_REDTEAM_PER_ROUND=16 npm run forcefield:ai-redteam
 *   FORCEFIELD_REDTEAM_BRIEF="CVE-2025-xxxx: new path-traversal via %c0%af" npm run forcefield:ai-redteam
 *   FORCEFIELD_REDTEAM_BRIEF_FILE=./threats.md npm run forcefield:ai-redteam
 *
 * SCALES WITH THE NEWS: pass a threat brief (a pasted disclosure, CVE, or a file of
 * recent tradecraft) and the generator steers toward it, so a novel attack in the
 * morning's feed becomes a test case the same day.
 *
 * AI-CONTAINMENT BOUNDARY: this is the ONLY part of Forcefield that calls a model,
 * and it runs OFFLINE in the factory. It routes through the governed model router
 * (getAIClient) so it is cost-attributed and budget-gated. Its OUTPUT is static
 * data a human reviews and commits into ai-redteam-corpus.ts; CI and the runtime
 * never call a model. Exits 0 (a discovery tool, not a gate); 2 only if it could
 * not run (no provider). It writes a report, it does not edit source.
 *
 * GAP METRIC: every round is scored with the SAME scoreGap used by CI, so the
 * factory number ("round 1 found 9 slips, round 4 found 0") and the committed
 * regression number are computed identically. That number is the thesis: how much
 * of the hostile population the deterministic gate prevents, measured, not claimed.
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { getAIClient } from "../src/lib/ai";
import { BudgetExceededError, NoProviderAvailableError } from "../src/lib/ai/types";
import { scoreGap, runGapCases, type GapCase, type GapScore } from "../src/lib/forcefield-web/gap-metric";
import { scoreCampaignGap, type CampaignCase } from "../src/lib/forcefield-web/campaign-redteam";
import { trackEvent } from "../src/lib/analytics";

const ROUNDS = Math.max(1, Math.min(10, Number(process.env.FORCEFIELD_REDTEAM_ROUNDS) || 3));
const PER_ROUND = Math.max(4, Math.min(40, Number(process.env.FORCEFIELD_REDTEAM_PER_ROUND) || 12));
const OUT = process.env.FORCEFIELD_REDTEAM_OUT || "forcefield-ai-redteam-report.json";

function threatBrief(): string {
  const file = process.env.FORCEFIELD_REDTEAM_BRIEF_FILE;
  if (file) {
    try { return readFileSync(file, "utf8").slice(0, 4000); } catch { /* fall through */ }
  }
  return (process.env.FORCEFIELD_REDTEAM_BRIEF ?? "").slice(0, 4000);
}

const SYSTEM =
  "You are a red-team generator attacking a deterministic web bot-defense engine. " +
  "The engine blocks, with high precision, exactly four proven-hostile classes: " +
  "(1) a request to an invisible honeypot/decoy path, (2) a User-Agent that names a " +
  "scanner/exploit tool (sqlmap, nikto, nmap, nuclei, wpscan, gobuster, ffuf, acunetix, masscan), " +
  "(3) an injection payload in the URL (path traversal, SQLi, XSS, open redirect, command injection), " +
  "and (4) a fingerprint an admin blocked. It deliberately does NOT block vague or " +
  "unproven traffic. Your job: invent NOVEL, obfuscated, or encoding-trick variants " +
  "that a real attacker would try in order to EVADE those four checks, PLUS a few " +
  "benign requests that merely LOOK hostile (a blog post about SQL injection, a filter " +
  "named 'select') to probe for false positives. " +
  "Return ONLY a JSON array, each item: {\"name\": string, \"path\": string, " +
  "\"rawUrl\": string (path+query), \"method\": string, \"userAgent\": string, " +
  "\"headerNames\": string[] (lowercased), \"intendedHostile\": boolean, \"rationale\": string}. " +
  "No prose, no code fences. Be genuinely novel; do not repeat obvious textbook strings.";

interface GenItem {
  name: string; path?: string; rawUrl?: string; method?: string;
  userAgent?: string; headerNames?: string[]; intendedHostile?: boolean; rationale?: string;
}

function parseItems(content: string): GenItem[] {
  let txt = content.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf("[");
  const end = txt.lastIndexOf("]");
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  try {
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toCase(it: GenItem, round: number, i: number): GapCase | null {
  const path = typeof it.path === "string" && it.path ? it.path : (typeof it.rawUrl === "string" ? it.rawUrl.split("?")[0] : "");
  if (!path) return null;
  return {
    name: (it.name || `r${round}-${i}`).slice(0, 120),
    input: {
      path,
      rawUrl: typeof it.rawUrl === "string" ? it.rawUrl : path,
      method: typeof it.method === "string" ? it.method : "GET",
      userAgent: typeof it.userAgent === "string" ? it.userAgent : "Mozilla/5.0",
      headerNames: Array.isArray(it.headerNames) ? it.headerNames.map(String) : ["host", "user-agent"],
    },
    intendedHostile: it.intendedHostile !== false,
  };
}

const CAMPAIGN_SYSTEM =
  "You are a red-team generator attacking a deterministic MULTI-STEP defense. It " +
  "holds one operator's recent request sequence and flags campaign SHAPES: " +
  "(1) recon_breadth (enumerating many distinct sensitive/decoy paths), " +
  "(2) kill_chain (a sensitive/decoy access THEN a bulk-export, in that order), " +
  "(3) id_enumeration (walking many distinct numeric ids on one endpoint). It does " +
  "NOT flag a normal multi-page session. Your job: invent NOVEL multi-step campaigns " +
  "where each individual request looks benign but the SEQUENCE is an attack and that " +
  "might EVADE those three shapes (e.g. interleave benign steps, pace requests, use " +
  "non-obvious export paths, chain a scraped id), PLUS a few realistic benign " +
  "multi-page sessions to probe for false campaign flags. " +
  "Return ONLY a JSON array, each item: {\"name\": string, \"steps\": " +
  "[{\"path\": string, \"method\": string}], \"intendedHostile\": boolean, " +
  "\"rationale\": string}. No prose, no code fences.";

interface GenCampaign { name?: string; steps?: Array<{ path?: string; method?: string }>; intendedHostile?: boolean; rationale?: string }

function parseCampaigns(content: string): CampaignCase[] {
  let txt = content.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf("[");
  const end = txt.lastIndexOf("]");
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  let arr: GenCampaign[];
  try { arr = JSON.parse(txt); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((c, i): CampaignCase | null => {
      const steps = Array.isArray(c.steps)
        ? c.steps.filter((s) => typeof s?.path === "string" && s.path).map((s) => ({ path: s.path as string, method: typeof s.method === "string" ? s.method : "GET" }))
        : [];
      if (steps.length < 2) return null; // a campaign is multi-step by definition
      return { name: (c.name || `campaign-${i}`).slice(0, 120), steps, intendedHostile: c.intendedHostile !== false };
    })
    .filter((c): c is CampaignCase => c !== null);
}

// Offline campaign phase: generate multi-step campaigns and score them against the
// real detectCampaign engine via the SAME gap scorer. Slips are campaign shapes we
// do not yet detect, the next signatures to add to campaign.ts. On by default; set
// FORCEFIELD_REDTEAM_CAMPAIGNS=off to skip. Returns the slip names for the report.
async function runCampaignPhase(client: ReturnType<typeof getAIClient>, brief: string): Promise<{ score: GapScore; slips: string[] } | null> {
  if (process.env.FORCEFIELD_REDTEAM_CAMPAIGNS === "off") return null;
  let content = "";
  try {
    const res = await client.complete({
      system: CAMPAIGN_SYSTEM,
      messages: [{ role: "user", content: (brief ? `Recent tradecraft to prioritize:\n${brief}\n\n` : "") + `Generate ${PER_ROUND} distinct multi-step campaigns. Vary how each evades the three shapes.` }],
      model_tier: "standard",
      max_tokens: 2200,
      temperature: 0.9,
      sensitivity: "public",
      latency_target: "batch",
      metadata: { feature: "forcefield.ai_redteam_campaign" },
    });
    content = res.content;
  } catch (err) {
    console.error(`Campaign phase generation error: ${(err as Error).message}`);
    return null;
  }
  const campaigns = parseCampaigns(content);
  if (campaigns.length === 0) { console.log("  campaign phase: no parseable campaigns; skipping."); return null; }
  const score = scoreCampaignGap(campaigns);
  console.log(
    `  campaigns: ${score.hostile} hostile, detected ${score.prevented} (${score.preventedPct}%), ` +
    `SLIPS ${score.slipped}, false flags ${score.falsePositives}`,
  );
  void trackEvent("forcefield.redteam_round_scored", "forcefield.ai_redteam_campaign", "forcefield", {
    round: 0, generated: campaigns.length, hostile: score.hostile, prevented: score.prevented,
    preventedPct: score.preventedPct, slipped: score.slipped, falsePositives: score.falsePositives,
  });
  return { score, slips: score.slips.map((s) => s.name) };
}

async function run(): Promise<number> {
  const client = getAIClient();
  const brief = threatBrief();
  console.log(`Forcefield AI red-team: ${ROUNDS} rounds x ${PER_ROUND} cases${brief ? " (threat brief supplied)" : ""}`);

  const allSlips: Array<{ round: number; name: string; input: GapCase["input"] }> = [];
  const newlyBlocked: GapCase[] = []; // confirmed-blocked novel attacks -> review + commit to the corpus
  const roundScores: GapScore[] = [];
  let dryStreak = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    const user =
      (brief ? `Recent tradecraft to prioritize:\n${brief}\n\n` : "") +
      `Generate ${PER_ROUND} distinct cases for round ${round}. Vary the evasion technique across items.`;
    let content = "";
    try {
      const res = await client.complete({
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
        model_tier: "standard",
        max_tokens: 1800,
        temperature: 0.9, // high: we WANT divergent, surprising attacks
        sensitivity: "public", // synthetic attack strings we author; no real data
        latency_target: "batch",
        metadata: { feature: "forcefield.ai_redteam" },
      });
      content = res.content;
    } catch (err) {
      if (err instanceof NoProviderAvailableError) {
        console.error("No model provider configured. Set the Azure OpenAI env the RAG stack uses, then retry.");
        return 2;
      }
      if (err instanceof BudgetExceededError) {
        console.error("AI budget exceeded for this workspace; stopping early with the rounds completed so far.");
        break;
      }
      console.error(`Round ${round} generation error: ${(err as Error).message}`);
      continue;
    }

    const cases = parseItems(content).map((it, i) => toCase(it, round, i)).filter((c): c is GapCase => c !== null);
    if (cases.length === 0) {
      console.log(`  round ${round}: model returned no parseable cases; skipping.`);
      continue;
    }
    const outcomes = runGapCases(cases);
    const score = scoreGap(outcomes);
    roundScores.push(score);

    // Slips = hostile AND not blocked = open gaps (the next rules to write).
    for (const s of score.slips) allSlips.push({ round, name: s.name, input: s.input as GapCase["input"] });
    // Confirmed-blocked novel attacks become regression candidates for the corpus.
    for (const o of outcomes) {
      if (o.intendedHostile && o.blocked && o.input) newlyBlocked.push({ name: o.name, input: o.input, intendedHostile: true });
    }

    console.log(
      `  round ${round}: ${score.hostile} hostile, prevented ${score.prevented} (${score.preventedPct}%), ` +
      `SLIPS ${score.slipped}, false positives ${score.falsePositives}`,
    );
    void trackEvent("forcefield.redteam_round_scored", "forcefield.ai_redteam", "forcefield", {
      round, generated: cases.length, hostile: score.hostile, prevented: score.prevented,
      preventedPct: score.preventedPct, slipped: score.slipped, falsePositives: score.falsePositives,
    });

    if (score.slipped === 0 && score.falsePositives === 0) { dryStreak++; } else { dryStreak = 0; }
    if (dryStreak >= 2) {
      console.log(`  two dry rounds in a row: the AI could not find a new gap. Stopping (loop-until-dry).`);
      break;
    }
  }

  // Multi-step phase: generate campaigns and score them against detectCampaign.
  const campaignResult = await runCampaignPhase(client, brief);

  const overall = scoreGap(
    roundScores.flatMap((s) => [
      ...Array.from({ length: s.prevented }, () => ({ name: "p", intendedHostile: true, blocked: true })),
      ...s.slips.map((x) => ({ name: x.name, intendedHostile: true, blocked: false })),
      ...Array.from({ length: s.falsePositives }, () => ({ name: "fp", intendedHostile: false, blocked: true })),
    ]),
  );

  const report = {
    generatedAtMs: Date.now(),
    rounds: roundScores.length,
    overall: { hostile: overall.hostile, prevented: overall.prevented, preventedPct: overall.preventedPct, slipped: overall.slipped, falsePositives: overall.falsePositives },
    slips: allSlips,
    newlyBlockedCandidates: newlyBlocked,
    campaigns: campaignResult
      ? { hostile: campaignResult.score.hostile, detected: campaignResult.score.prevented, preventedPct: campaignResult.score.preventedPct, slipped: campaignResult.score.slipped, falseFlags: campaignResult.score.falsePositives, slipNames: campaignResult.slips }
      : null,
    note: "Slips are open gaps: write a rule for each, confirm the engine blocks it, then move it into ai-redteam-corpus.ts (single request) or add a signature to campaign.ts (multi-step campaign). False positives are the opposite gap: a rule is too broad.",
  };
  try {
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${OUT}`);
  } catch (err) {
    console.error(`Could not write report: ${(err as Error).message}`);
  }

  console.log(
    `\nGAP METRIC: deterministic gate prevented ${overall.prevented}/${overall.hostile} hostile cases ` +
    `(${overall.preventedPct}%). Open gaps (slips): ${allSlips.length}. False positives: ${overall.falsePositives}.`,
  );
  if (campaignResult) {
    console.log(
      `CAMPAIGN GAP: detector caught ${campaignResult.score.prevented}/${campaignResult.score.hostile} ` +
      `multi-step campaigns (${campaignResult.score.preventedPct}%). Open campaign gaps: ${campaignResult.slips.length}.`,
    );
    for (const name of campaignResult.slips.slice(0, 10)) console.log(`  - campaign slip (add a signature to campaign.ts): ${name}`);
  }
  if (allSlips.length > 0) {
    console.log(`\nOpen gaps to rule (review ${OUT}):`);
    for (const s of allSlips.slice(0, 20)) console.log(`  - [r${s.round}] ${s.name}  ${s.input.rawUrl ?? s.input.path}`);
  }
  return 0;
}

run().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * One-click demo seed: restore a known-good, populated governance state across
 * all five demo beats, so a live sales walkthrough always lands.
 *
 *   Discover -> AI surfaces found in a sample target (governed + ungoverned).
 *   Govern   -> a spread of real gate decisions (allow / transform / escalate /
 *               block) + a mix of enforce/monitor postures.
 *   Assure   -> a continuous red-team run against the gate.
 *   Comply   -> framework coverage reports derived from the seeded evidence.
 *
 * The seed runs through the SAME domain functions a live client hits: the gate
 * (authorize -> decide -> the tamper-evident ledger), the inventory upsert, the
 * red-team executor, the compliance orchestrator. Nothing is injected at the DB
 * layer, so the demo data is honest, audited, triple-written, and feeds the
 * learning loop exactly as production traffic would. It is also idempotent-safe
 * to re-run before a demo: surfaces + enforcement upsert in place; decisions,
 * red-team runs, and reports append to their (append-only) ledgers.
 */

import { authorize } from "./authorize";
import type { BuildActionInput } from "./action";
import { setEnforcementPolicy } from "./enforcement-policy";
import { runDiscovery } from "@/lib/ai-surface/inventory";
import type { SourceFile } from "@/lib/ai-surface/detect";
import { executeRedTeam } from "@/lib/ai-redteam/execute";
import { runComplianceReport } from "@/lib/compliance/orchestrate";
import { ALL_FRAMEWORKS } from "@/lib/compliance/frameworks";
import type { OgiamEnforcementMode, OgiamPrincipal } from "./types";

/** A stable, obviously-fictional target so the seed never collides with a real
 *  onboarded client's inventory. */
export const DEMO_TARGET = "demo/acme-agent-platform";
const DEMO_AGENT = "demo.sales-assistant";

export interface DemoSeedResult {
  target: string;
  surfaces: { found: number; written: number; ungoverned: number };
  decisions: { recorded: number; flagged: number; wouldBlock: number };
  enforcement: { capability: string; mode: OgiamEnforcementMode }[];
  redteam: { attacks: number; blocked: number; vulns: number; passRate: number };
  compliance: { framework: string; coverage: number; gap: number }[];
}

/** A small sample codebase that exercises the AI-surface detectors: two SDK
 *  imports (one ungoverned), a provider endpoint, and a leaked provider key.
 *  The key is BUILT at runtime (never a source literal) so it trips neither the
 *  repo secret scanner nor the redactor at rest. */
export function demoSourceFiles(): SourceFile[] {
  // 40-char suffix so it matches the OpenAI key signature (sk- + 32+ chars).
  // Built at runtime, never a source literal, so it trips neither the repo
  // secret scanner nor the redactor at rest.
  const leakedKey = "sk-" + "demoSeed".repeat(5);
  return [
    { path: "services/assistant/llm.ts", content: `import Anthropic from "@anthropic-ai/sdk";\nexport const client = new Anthropic();` },
    { path: "services/support/agent.ts", content: `import { OpenAI } from "openai";\nconst c = new OpenAI({ baseURL: "https://api.openai.com/v1" });` },
    { path: "workers/summarize.ts", content: `// calls https://acme.openai.azure.com/openai/deployments/gpt-4o\nconst url = "https://acme.openai.azure.com/openai/deployments/gpt-4o";` },
    { path: "config/secrets.example", content: `OPENAI_API_KEY=${leakedKey}` },
    { path: "chains/router.ts", content: `import { ChatPromptTemplate } from "@langchain/core/prompts";` },
  ];
}

/** Demo gate decisions, crafted to produce the full outcome spread the policy
 *  supports, so the Govern beat shows allow + transform + escalate + block. */
export function demoActions(): { input: BuildActionInput; mode: OgiamEnforcementMode }[] {
  const base = { workflowId: "demo-seed" };
  // A credential in params -> R-SECRET-DENY. Built at runtime, not a literal;
  // long enough (sk- + 40 chars) to match the redactor's api_key signature.
  const leakedSecret = "sk-" + "exfilTok".repeat(5);
  return [
    {
      mode: "monitor",
      input: { ...base, tool: "search_knowledge", capability: "knowledge.read", isMutation: false, surface: "assistant", params: { query: "Q3 enterprise pipeline" } },
    },
    {
      mode: "enforce",
      input: { ...base, tool: "send_email", capability: "communication.send_external", isMutation: true, surface: "mail", params: { to: "buyer@example.com", body: "Following up on the proposal; reach me at buyer@example.com." } },
    },
    {
      mode: "enforce",
      input: { ...base, tool: "issue_refund", capability: "finance.payment", isMutation: true, surface: "billing", params: { amount: 4200, customer: "acme-co" } },
    },
    {
      mode: "enforce",
      input: { ...base, tool: "export_dataset", capability: "data.export", isMutation: true, surface: "warehouse", params: { destination: "s3://exfil", token: leakedSecret } },
    },
    {
      mode: "monitor",
      input: { ...base, tool: "list_contacts", capability: "people.read", isMutation: false, surface: "assistant", params: { team: "sales" } },
    },
  ];
}

/** The enforcement postures the Govern beat displays: a deliberate mix so the
 *  monitor<->enforce control knob is visible. */
const DEMO_POSTURES: { capability: string; mode: OgiamEnforcementMode }[] = [
  { capability: "communication.send_external", mode: "enforce" },
  { capability: "finance.payment", mode: "enforce" },
  { capability: "data.export", mode: "monitor" },
  { capability: "knowledge.read", mode: "monitor" },
];

export async function seedGovernanceDemo(args: {
  workspaceId: string;
  actorId: string;
  actorRole: string;
  nowIso: string;
}): Promise<DemoSeedResult> {
  const { workspaceId, actorId, actorRole, nowIso } = args;

  // 1. Discover - AI surfaces (idempotent upsert by deterministic surface id).
  const discovery = await runDiscovery({ workspaceId, target: DEMO_TARGET, files: demoSourceFiles() });

  // 2. Govern - enforcement postures (idempotent upsert by (workspace, capability)).
  for (const p of DEMO_POSTURES) {
    await setEnforcementPolicy({ workspaceId, capability: p.capability, mode: p.mode, updatedBy: actorId });
  }

  // 3. Govern - a spread of real gate decisions recorded to the ledger.
  const principal: OgiamPrincipal = {
    kind: "ai_agent",
    agent: DEMO_AGENT,
    onBehalfOfUserId: actorId,
    onBehalfOfRole: actorRole,
    workspaceId,
    ownerUserId: actorId,
  };
  let recorded = 0;
  let flagged = 0;
  let wouldBlock = 0;
  for (const { input, mode } of demoActions()) {
    const decision = await authorize({ ...input, principal, mode });
    recorded += 1;
    if (decision.intendedOutcome !== "allow") flagged += 1;
    if (decision.wouldBlock) wouldBlock += 1;
  }

  // 4. Assure - a real red-team run against the gate.
  const { report: rt } = await executeRedTeam({ workspaceId, actorId, actorRole, source: "manual", nowIso });

  // 5. Comply - framework coverage derived from the now-populated evidence.
  const compliance: { framework: string; coverage: number; gap: number }[] = [];
  for (const framework of ALL_FRAMEWORKS) {
    const { report } = await runComplianceReport(workspaceId, framework, nowIso);
    compliance.push({ framework, coverage: report.coverage, gap: report.gap });
  }

  return {
    target: DEMO_TARGET,
    surfaces: { found: discovery.surfaces.length, written: discovery.written, ungoverned: discovery.summary.ungoverned },
    decisions: { recorded, flagged, wouldBlock },
    enforcement: DEMO_POSTURES,
    redteam: { attacks: rt.attacksRun, blocked: rt.blocked, vulns: rt.vulns.length, passRate: rt.passRate },
    compliance,
  };
}

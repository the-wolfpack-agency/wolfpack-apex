/** collectPostureFacts reads the same probes as compliance + assurance; a dead
 *  database is unknown, never a pass. */
import { collectPostureFacts, guardrailFromBaseline } from "../posture-evidence";
import { checkPostureParity } from "../posture-claims";
import type { EvidenceExecutor } from "../evidence-window";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

it("no database: every DB-backed claim is unknown, none proven, none a violation", async () => {
  const f = await collectPostureFacts("w1", null, NOW, {});
  expect(f.chain?.state).toBe("error");
  expect(f.hybridTlsAssertedInCi).toBe(false);
  const r = checkPostureParity(f);
  for (const k of ["secrets.oauth_tokens_encrypted", "isolation.db_rls", "audit.hash_chain", "signing.ledger_checkpoints"]) {
    expect(r.results.find((x) => x.key === k)!.evidence).toBe("unknown");
  }
  expect(r.violations).toBe(0);
});

it("a throwing executor reads unknown, not gap and not proven", async () => {
  const exec: EvidenceExecutor = async () => { throw new Error("connection refused"); };
  const f = await collectPostureFacts("w1", exec, NOW, { PROD_DOMAIN: "x.example" });
  expect(f.chain?.state).toBe("error");
  expect(f.platform?.oauthTokens).toBeNull();
  expect(f.hybridTlsAssertedInCi).toBe(true);
});

it("fresh chain rows prove the hash-chain claim", async () => {
  const exec: EvidenceExecutor = async (sql) =>
    /audit\.chain_verified/.test(sql) ? { rows: [{ n: 24, last: new Date(NOW - 3600_000).toISOString() }] } : { rows: [{}] };
  const f = await collectPostureFacts("w1", exec, NOW, {});
  expect(checkPostureParity(f).results.find((x) => x.key === "audit.hash_chain")!.evidence).toBe("proven");
});

it("the guardrail fact comes from the committed baseline and fails closed", () => {
  expect(guardrailFromBaseline({ unclassifiedCount: 0, scopedTableCount: 10 })).toBe(true);
  expect(guardrailFromBaseline({ unclassifiedCount: 3, scopedTableCount: 10 })).toBe(false);
  expect(guardrailFromBaseline({})).toBeNull();
});

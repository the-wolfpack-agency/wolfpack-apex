/**
 * Independent-family judge: the verdict parser, cross-family selection, the
 * fail-loud UNCHECKED path (no sibling ever judges), cost cap, and unreachable.
 * The candidate list is injected so the test is deterministic (no env/network).
 */
import { parseFindingVerdict, judgeFindings, type JudgeComplete } from "../judge";
import type { AiCodeFinding } from "../types";

const finding = (over: Partial<AiCodeFinding> = {}): AiCodeFinding => ({
  file: "x.ts", line: 1, klass: "secret", severity: "critical", cwe: "CWE-798",
  title: "t", detail: "d", evidence: { snippet: "s" }, ...over,
});
const ANTHROPIC = [{ provider: "anthropic", model: "claude-haiku-4-5" }]; // different family than gpt
const OPENAI_SIBLING = [{ provider: "openai", model: "gpt-4o" }];

describe("parseFindingVerdict", () => {
  it("parses each verdict; unclear -> needs_review (never dismisses)", () => {
    expect(parseFindingVerdict("VERDICT: confirmed REASON: real")).toBe("confirmed");
    expect(parseFindingVerdict("VERDICT: false_positive REASON: no")).toBe("false_positive");
    expect(parseFindingVerdict("VERDICT: false positive")).toBe("false_positive");
    expect(parseFindingVerdict("VERDICT: needs_review")).toBe("needs_review");
    expect(parseFindingVerdict("garbled nonsense")).toBe("needs_review");
  });
});

describe("judgeFindings", () => {
  const confirms: JudgeComplete = async () => "VERDICT: confirmed REASON: real";

  it("judges with a DIFFERENT family and attaches the verdict", async () => {
    const calls: string[] = [];
    const complete: JudgeComplete = async ({ providerPin }) => { calls.push(providerPin); return "VERDICT: confirmed REASON: real"; };
    const out = await judgeFindings({ findings: [finding()], authorModel: "gpt-4o", complete, candidates: ANTHROPIC });
    expect(out[0].verdict).toBe("confirmed");
    expect(out[0].judgeLineage).toBe("anthropic");
    expect(out[0].authorLineage).toBe("openai");
    expect(calls).toEqual(["anthropic"]); // pinned to the independent provider
  });

  it("records UNCHECKED (never a sibling) when only same-family judges exist", async () => {
    const complete: JudgeComplete = async () => { throw new Error("should not be called"); };
    const out = await judgeFindings({ findings: [finding()], authorModel: "gpt-4o", complete, candidates: OPENAI_SIBLING });
    expect(out[0].verdict).toBe("unchecked");
    expect(out[0].reason).toBe("no_independent_lineage_configured");
  });

  it("records UNCHECKED when the author lineage is unknown", async () => {
    const out = await judgeFindings({ findings: [finding()], authorModel: "", complete: confirms, candidates: ANTHROPIC });
    expect(out[0].verdict).toBe("unchecked");
    expect(out[0].reason).toBe("author_lineage_unknown");
  });

  it("marks a finding unchecked when the judge is unreachable (never a pass or a dismiss)", async () => {
    const boom: JudgeComplete = async () => { throw new Error("down"); };
    const out = await judgeFindings({ findings: [finding()], authorModel: "gpt-4o", complete: boom, candidates: ANTHROPIC });
    expect(out[0].verdict).toBe("unchecked");
    expect(out[0].reason).toBe("judge_unreachable");
  });

  it("respects the cost cap (maxJudged)", async () => {
    let n = 0;
    const complete: JudgeComplete = async () => { n++; return "VERDICT: confirmed"; };
    const out = await judgeFindings({ findings: [finding(), finding(), finding()], authorModel: "gpt-4o", complete, candidates: ANTHROPIC, maxJudged: 2 });
    expect(out).toHaveLength(2);
    expect(n).toBe(2);
  });
});

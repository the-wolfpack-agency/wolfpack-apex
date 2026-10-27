import { attackLabel, ATTACK_LABEL } from "@/lib/forcefield-web/attack-labels";
import { attackLabel as timelineLabel } from "@/components/AgentJourneyTimeline";
import { PAYLOAD_CWE } from "@/lib/forcefield-web/enforce";

describe("one plain-language attack name map", () => {
  it("names the body-marker RCE families in plain language", () => {
    expect(attackLabel("php2shell")).toBe("PHP2Shell, PHP server takeover");
    expect(attackLabel("react2shell")).toBe("React2Shell, React/Next.js server takeover");
  });

  it("the board timeline uses the same map", () => {
    expect(timelineLabel("react2shell")).toBe(attackLabel("react2shell"));
  });

  it("every family the engine assigns a CWE has a plain-language name", () => {
    const missing = Object.keys(PAYLOAD_CWE).filter((k) => !ATTACK_LABEL[k]);
    expect(missing).toEqual([]);
  });

  it("falls back to the de-underscored id", () => {
    expect(attackLabel("brand_new_family")).toBe("brand new family");
  });
});

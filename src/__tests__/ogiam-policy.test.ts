import { riskTierFor } from "../lib/ogiam/policy";
import type { OgiamAction } from "../lib/ogiam/types";

describe("riskTierFor", () => {
  it("classifies a mutation with 'deploy' in the capability as high risk", () => {
    const action: OgiamAction = {
      capability: "deploy.environment",
      tool: "deploymentTool",
      isMutation: true,
      signals: {},
    };
    expect(riskTierFor(action)).toBe("high");
  });

  it("classifies a mutation with 'repository' in the capability as high risk", () => {
    const action: OgiamAction = {
      capability: "repository.access",
      tool: "repoManager",
      isMutation: true,
      signals: {},
    };
    expect(riskTierFor(action)).toBe("high");
  });
});
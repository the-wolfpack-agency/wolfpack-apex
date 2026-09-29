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

  it("classifies a non-mutation action as low risk regardless of capability", () => {
    const action: OgiamAction = {
      capability: "deploy.environment",
      tool: "deploymentTool",
      isMutation: false,
      signals: {},
    };
    expect(riskTierFor(action)).toBe("low");
  });

  it("classifies a mutation with no high-risk fragments as medium risk", () => {
    const action: OgiamAction = {
      capability: "read.data",
      tool: "dataViewer",
      isMutation: true,
      signals: {},
    };
    expect(riskTierFor(action)).toBe("medium");
  });

  it("classifies an action with a detected secret as critical risk", () => {
    const action: OgiamAction = {
      capability: "read.data",
      tool: "dataViewer",
      isMutation: true,
      signals: { secretDetected: true },
    };
    expect(riskTierFor(action)).toBe("critical");
  });
});
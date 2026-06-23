/**
 * Agent identity tests. The security-critical assertions: an agent token round
 * trips, the human resolver rejects an agent token, and the agent resolver
 * rejects a human token. Those two boundaries are the whole "agents cannot
 * impersonate people and vice versa" guarantee.
 */

import {
  LocalAgentIdentity,
  getAgentIdentity,
  resolveAgentFromRequest,
  EntraAgentIdentity,
} from "@/lib/agents/identity";
import { signToken } from "@/lib/crypto/sign";
import { getUserFromRequest } from "@/lib/auth";

const local = new LocalAgentIdentity();

async function mintAgentToken() {
  const issued = await local.issueAccessToken({
    agentId: "agent-1",
    role: "ops",
    workspaceId: "ws-1",
    ownerUserId: "owner-1",
  });
  return issued.token;
}

describe("LocalAgentIdentity round trip", () => {
  it("issues then verifies an agent token into a principal", async () => {
    const issued = await local.issueAccessToken({
      agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1",
    });
    expect(issued.token).toBeTruthy();
    expect(issued.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const principal = await local.verifyAccessToken(issued.token);
    expect(principal).toEqual({
      agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1", provider: "local",
    });
  });

  it("rejects a malformed token", async () => {
    expect(await local.verifyAccessToken("not-a-token")).toBeNull();
  });

  it("rejects a human session token (no kind:agent / wrong audience)", async () => {
    const humanToken = signToken({ userId: "u1", email: "u@x", role: "cto", name: "U" });
    expect(await local.verifyAccessToken(humanToken)).toBeNull();
  });
});

describe("security boundary: agent vs human resolvers are mutually exclusive", () => {
  it("getUserFromRequest rejects an agent token (no human session for an agent)", async () => {
    const token = await mintAgentToken();
    expect(getUserFromRequest(`Bearer ${token}`)).toBeNull();
  });

  it("resolveAgentFromRequest accepts an agent token", async () => {
    const token = await mintAgentToken();
    const principal = await resolveAgentFromRequest(`Bearer ${token}`);
    expect(principal?.agentId).toBe("agent-1");
  });

  it("resolveAgentFromRequest rejects a human token", async () => {
    const humanToken = signToken({ userId: "u1", email: "u@x", role: "cto", name: "U" });
    expect(await resolveAgentFromRequest(`Bearer ${humanToken}`)).toBeNull();
  });

  it("resolveAgentFromRequest rejects a missing/!bearer header", async () => {
    expect(await resolveAgentFromRequest(null)).toBeNull();
    expect(await resolveAgentFromRequest("Basic abc")).toBeNull();
  });
});

describe("getAgentIdentity provider resolution", () => {
  it("defaults to local", () => {
    expect(getAgentIdentity({} as NodeJS.ProcessEnv).provider).toBe("local");
  });
  it("selects Entra when fully configured", () => {
    const id = getAgentIdentity({
      OGIAM_AGENT_IDENTITY_PROVIDER: "entra",
      OGIAM_AGENT_ENTRA_TENANT_ID: "t",
      OGIAM_AGENT_ENTRA_AUDIENCE: "api://ogiam-agent",
    } as unknown as NodeJS.ProcessEnv);
    expect(id.provider).toBe("entra");
    expect(id).toBeInstanceOf(EntraAgentIdentity);
  });
  it("stays local when the entra flag is set but config is incomplete", () => {
    const id = getAgentIdentity({
      OGIAM_AGENT_IDENTITY_PROVIDER: "entra",
    } as unknown as NodeJS.ProcessEnv);
    expect(id.provider).toBe("local");
  });
});

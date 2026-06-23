/**
 * On-behalf-of (RFC 8693 delegation) token tests.
 *
 * The security-critical guarantees proven here:
 *   - A minted on-behalf token verifies to the OWNER context plus the acting
 *     agent. The identity is the owner (so the route enforces the owner's
 *     authority), never the agent.
 *   - Expiry is enforced: a token past its TTL is rejected (returns null), both
 *     by verifyOnBehalfToken and by getUserFromRequest.
 *   - Audience segregation: a normal human session token and an agent token
 *     (aud "ogiam-agent") are NOT accepted on the on-behalf path.
 *   - The existing human/agent boundary is UNCHANGED: a pure agent token is
 *     still rejected by getUserFromRequest (no regression).
 *   - A tampered signature is rejected.
 *   - getUserFromRequest surfaces actingAgentId so downstream can audit the
 *     delegation, and the identity it returns is the owner, not the agent.
 */

import {
  mintOnBehalfToken,
  verifyOnBehalfToken,
  ON_BEHALF_AUDIENCE,
  ON_BEHALF_TOKEN_TTL_SECONDS,
} from "@/lib/agents/on-behalf";
import { LocalAgentIdentity } from "@/lib/agents/identity";
import { signToken } from "@/lib/crypto/sign";
import { getUserFromRequest } from "@/lib/auth";

const OWNER = {
  ownerUserId: "owner-1",
  ownerRole: "cto",
  workspaceId: "ws-1",
  agentId: "agent-7",
};

describe("mint + verify on-behalf token", () => {
  it("verifies a freshly minted token to the OWNER context + actingAgentId", async () => {
    const token = await mintOnBehalfToken(OWNER);
    const ctx = await verifyOnBehalfToken(token);
    expect(ctx).toEqual({
      ownerUserId: "owner-1",
      ownerRole: "cto",
      workspaceId: "ws-1",
      actingAgentId: "agent-7",
    });
  });

  it("identity is the OWNER, not the agent (capabilities resolve to the owner)", async () => {
    const token = await mintOnBehalfToken(OWNER);
    const ctx = await verifyOnBehalfToken(token);
    // The subject/identity is the owner; the agent appears only as the actor.
    expect(ctx?.ownerUserId).toBe("owner-1");
    expect(ctx?.ownerRole).toBe("cto");
    expect(ctx?.actingAgentId).toBe("agent-7");
    expect(ctx?.ownerUserId).not.toBe(ctx?.actingAgentId);
  });

  it("defaults to the short 60s TTL", () => {
    expect(ON_BEHALF_TOKEN_TTL_SECONDS).toBe(60);
  });
});

describe("EXPIRY", () => {
  it("rejects a token past its TTL (verifyOnBehalfToken returns null)", async () => {
    // Mint already-expired: a negative TTL puts exp in the past.
    const token = await mintOnBehalfToken(OWNER, -10);
    expect(await verifyOnBehalfToken(token)).toBeNull();
  });

  it("getUserFromRequest does not authenticate an expired on-behalf token", async () => {
    const token = await mintOnBehalfToken(OWNER, -10);
    expect(getUserFromRequest(`Bearer ${token}`)).toBeNull();
  });
});

describe("AUDIENCE segregation", () => {
  it("rejects a normal human session token (wrong audience)", async () => {
    const humanToken = signToken({
      userId: "u1",
      email: "u@x",
      role: "cto",
      name: "U",
    });
    expect(await verifyOnBehalfToken(humanToken)).toBeNull();
  });

  it("rejects an agent token (aud ogiam-agent, not instinct-onbehalf)", async () => {
    const issued = await new LocalAgentIdentity().issueAccessToken({
      agentId: "agent-7",
      role: "ops",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });
    expect(await verifyOnBehalfToken(issued.token)).toBeNull();
  });

  it("rejects a token forged with a foreign audience", async () => {
    // Same crypto secret, but the wrong aud must still be rejected: audience is
    // a real authorization boundary, not decoration.
    const forged = signToken({
      sub: "owner-1",
      kind: "on-behalf",
      aud: "some-other-aud",
      ownerRole: "cto",
      workspaceId: "ws-1",
      act: { agent: "agent-7" },
    });
    expect(await verifyOnBehalfToken(forged)).toBeNull();
  });

  it("rejects a correctly-audienced token that is NOT the on-behalf kind", async () => {
    // Defense in depth: even with the right aud, a wrong kind is rejected.
    const wrongKind = signToken({
      sub: "owner-1",
      kind: "agent",
      aud: ON_BEHALF_AUDIENCE,
      ownerRole: "cto",
      workspaceId: "ws-1",
      act: { agent: "agent-7" },
    });
    expect(await verifyOnBehalfToken(wrongKind)).toBeNull();
  });

  it("rejects an on-behalf-shaped token missing the act/agent claim", async () => {
    const noActor = signToken({
      sub: "owner-1",
      kind: "on-behalf",
      aud: ON_BEHALF_AUDIENCE,
      ownerRole: "cto",
      workspaceId: "ws-1",
      // no act claim
    });
    expect(await verifyOnBehalfToken(noActor)).toBeNull();
  });
});

describe("tampered signature", () => {
  it("rejects a token whose payload was altered after signing", async () => {
    const token = await mintOnBehalfToken(OWNER);
    // Flip the last char of the signature segment to break verification.
    const parts = token.split(".");
    const sig = parts[2];
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    expect(await verifyOnBehalfToken(tampered)).toBeNull();
    expect(getUserFromRequest(`Bearer ${tampered}`)).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    expect(await verifyOnBehalfToken("not-a-token")).toBeNull();
    expect(await verifyOnBehalfToken("")).toBeNull();
  });
});

describe("getUserFromRequest acceptance of on-behalf tokens", () => {
  it("authenticates as the OWNER and carries actingAgentId for audit", async () => {
    const token = await mintOnBehalfToken(OWNER);
    const user = getUserFromRequest(`Bearer ${token}`);
    expect(user).not.toBeNull();
    // Identity is the owner, NOT the agent.
    expect(user?.id).toBe("owner-1");
    expect(user?.role).toBe("cto");
    expect(user?.workspaceId).toBe("ws-1");
    // Delegation is visible to routes/audit.
    expect(user?.actingAgentId).toBe("agent-7");
    expect(user?.id).not.toBe(user?.actingAgentId);
  });

  it("BOUNDARY UNCHANGED: a pure agent token is STILL rejected", async () => {
    const issued = await new LocalAgentIdentity().issueAccessToken({
      agentId: "agent-7",
      role: "ops",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });
    // The existing security boundary must not regress: an agent credential is
    // never a human session, even with the on-behalf path added.
    expect(getUserFromRequest(`Bearer ${issued.token}`)).toBeNull();
  });

  it("a normal human session token still authenticates with no actingAgentId", () => {
    const humanToken = signToken({
      userId: "u1",
      email: "u@x",
      role: "cto",
      name: "U",
      workspaceId: "ws-1",
    });
    const user = getUserFromRequest(`Bearer ${humanToken}`);
    expect(user?.id).toBe("u1");
    expect(user?.actingAgentId).toBeUndefined();
  });

  it("rejects a missing or non-bearer header", () => {
    expect(getUserFromRequest(null)).toBeNull();
    expect(getUserFromRequest("Basic abc")).toBeNull();
  });
});

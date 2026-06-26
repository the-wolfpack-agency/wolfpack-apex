/**
 * agents/invite-email — composes the agent-operator invite (join link +
 * one-time onboarding secret) and delivers it through the EXISTING Graph
 * sender. Tests assert:
 *   - the body carries the activation URL + onboarding secret (one-time copy);
 *   - sendAgentInviteEmail calls the underlying sender with the to-address;
 *   - it returns { ok: false } (never throws) when the sender throws.
 */

export {};

const mockSendViaGraph = jest.fn();
jest.mock("@/lib/mail/send-via-graph", () => ({
  sendViaGraph: (...a: any[]) => mockSendViaGraph(...a),
}));

import {
  buildAgentInviteEmailBody,
  sendAgentInviteEmail,
  type AgentInviteEmailInput,
} from "@/lib/agents/invite-email";

const INPUT: AgentInviteEmailInput = {
  to: "operator@thewolfpack.agency",
  agentName: "Researcher",
  agentId: "a_1",
  onboardingSecret: "deadbeef".repeat(8),
  activationUrl:
    "https://wolfpack-instinct.vercel.app/agents/activate?agent=a_1",
  invitedByRole: "cto",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildAgentInviteEmailBody", () => {
  it("includes the activation URL, the onboarding secret, agent name, and inviter role", () => {
    const body = buildAgentInviteEmailBody(INPUT);
    expect(body.text).toContain(INPUT.activationUrl);
    expect(body.text).toContain(INPUT.onboardingSecret);
    expect(body.text).toContain("Researcher");
    expect(body.text).toContain("cto");
    expect(body.html).toContain(INPUT.activationUrl);
    expect(body.html).toContain(INPUT.onboardingSecret);
  });

  it("makes the one-time nature of the secret explicit", () => {
    const body = buildAgentInviteEmailBody(INPUT);
    expect(body.text.toLowerCase()).toContain("one-time");
    expect(body.html.toLowerCase()).toContain("one-time");
  });

  it("escapes HTML in the agent name to prevent injection", () => {
    const body = buildAgentInviteEmailBody({
      ...INPUT,
      agentName: "<script>alert(1)</script>",
    });
    expect(body.html).not.toContain("<script>alert(1)</script>");
    expect(body.html).toContain("&lt;script&gt;");
  });
});

describe("sendAgentInviteEmail", () => {
  it("calls the existing Graph sender with the to-address and a body carrying the URL + secret", async () => {
    mockSendViaGraph.mockResolvedValue({ delivered: true, reason: "ok" });
    const res = await sendAgentInviteEmail(INPUT);
    expect(res).toEqual({ ok: true });
    expect(mockSendViaGraph).toHaveBeenCalledTimes(1);
    const arg = mockSendViaGraph.mock.calls[0][0];
    expect(arg.to).toBe(INPUT.to);
    expect(arg.text).toContain(INPUT.activationUrl);
    expect(arg.text).toContain(INPUT.onboardingSecret);
    expect(arg.html).toContain(INPUT.activationUrl);
    expect(arg.html).toContain(INPUT.onboardingSecret);
  });

  it("returns { ok: false } when the sender reports non-delivery", async () => {
    mockSendViaGraph.mockResolvedValue({ delivered: false, reason: "no_app_token" });
    const res = await sendAgentInviteEmail(INPUT);
    expect(res).toEqual({ ok: false });
  });

  it("returns { ok: false } and does NOT throw when the sender throws", async () => {
    mockSendViaGraph.mockRejectedValue(new Error("boom"));
    await expect(sendAgentInviteEmail(INPUT)).resolves.toEqual({ ok: false });
  });
});

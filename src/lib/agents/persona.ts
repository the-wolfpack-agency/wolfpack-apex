/**
 * Making an agent comprehensible to someone who is not an engineer.
 *
 * THE ADOPTION PROBLEM THIS IS FOR
 *
 * The barrier to using AI inside a company is rarely capability. It is that the
 * people who must approve it cannot tell what it is allowed to do or whether it
 * has behaved, so the safe answer is no. A fleet page that reads
 * "scanStatus: complete, connections: [salesforce]" gives an engineer
 * everything and a stakeholder nothing.
 *
 * THE RISK IN PERSONIFICATION, WHICH IS THE WHOLE DESIGN CONSTRAINT
 *
 * Giving an agent a face makes it feel trustworthy. That is the point and it is
 * also the danger: a friendly card on an ungoverned agent is worse than a wall
 * of JSON, because JSON does not reassure anyone. So the rule here is that
 * personification may make an agent easier to UNDERSTAND and must never make it
 * look more trustworthy than the evidence supports.
 *
 * In practice:
 *   - The avatar is derived, neutral and identical for a well-behaved and a
 *     misbehaving agent. It identifies; it does not endorse.
 *   - Capability language is concrete about what the agent can REACH, not soft
 *     about what it helps with. "Can read and change your Jira issues" is the
 *     sentence someone needs to approve or refuse.
 *   - An agent whose limits have never been demonstrated says so, in the same
 *     words, however tidy the rest of the card looks.
 *
 * Pure and offline: the avatar is computed, not fetched, so no external service
 * sees the fleet and no CSP exception is needed.
 */

export type AgentLifecycle = "invited" | "active" | "paused" | "revoked" | string;

/** Initials for the avatar. Two letters, from word boundaries where possible. */
export function initialsFor(name: string): string {
  const words = String(name ?? "")
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * A stable hue for an agent, so the same agent looks the same everywhere.
 *
 * Derived from the id rather than the name: a rename should not change who you
 * are looking at. Deliberately NOT tied to health — a red agent must be red
 * because it misbehaved, not because its id hashed that way, or the color
 * stops carrying meaning at exactly the moment it matters.
 */
export function hueFor(agentId: string): number {
  let hash = 0;
  for (const ch of String(agentId ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) % 360000;
  // Avoid the red band (0-25, 340-360): red is reserved for "needs a look".
  return 30 + (hash % 300);
}

/** What the lifecycle state means, without the jargon. */
export function describeState(state: AgentLifecycle): { label: string; detail: string } {
  switch (state) {
    case "active":
      return { label: "Working", detail: "This agent can act right now, within the limits below." };
    case "paused":
      return { label: "Paused", detail: "This agent is set up but not acting. Nothing it could do is happening." };
    case "invited":
      return { label: "Not started", detail: "Invited but has never connected, so it has done nothing at all." };
    case "revoked":
      return { label: "Shut off", detail: "Its access was withdrawn. It cannot act and cannot be restarted without being re-onboarded." };
    default:
      return { label: "Unknown", detail: "We could not read this agent's status, which is not the same as it being idle." };
  }
}

/** Connector name to something a non-engineer can approve or refuse. */
const SERVICE_COPY: Record<string, string> = {
  salesforce: "your Salesforce records",
  jira: "your Jira issues",
  github: "your GitHub repositories",
  slack: "your Slack messages",
  quickbooks: "your QuickBooks accounts",
  microsoft: "your Microsoft 365 mail, calendar and files",
  hubspot: "your HubSpot contacts",
  zendesk: "your Zendesk tickets",
  notion: "your Notion pages",
};

/**
 * What this agent can reach, in a sentence someone can act on.
 *
 * UNKNOWN AND NONE ARE DIFFERENT FACTS.
 *
 * An agent bound to nothing is reassuring and worth saying. An agent whose
 * bindings we could not read is not reassuring at all, and reporting it as "not
 * connected to anything" would be a confident false statement on the exact
 * surface someone uses to decide whether to trust it — which is worse than
 * saying nothing. The detail endpoint does not return connectors today, so this
 * distinction is load-bearing right now rather than theoretical.
 */
export function describeCapabilities(connections: readonly string[] | undefined): string {
  if (connections === undefined) {
    return "We could not read which of your systems this agent is connected to. That is not the same as it being connected to none.";
  }
  const bound = connections.filter(Boolean);
  if (bound.length === 0) {
    return "This agent is not connected to any of your systems, so it cannot read or change anything in them.";
  }
  const described = bound.map((c) => SERVICE_COPY[c.toLowerCase()] ?? `your ${c} account`);
  const list =
    described.length === 1
      ? described[0]
      : `${described.slice(0, -1).join(", ")} and ${described[described.length - 1]}`;
  return `This agent can reach ${list}. Every action it takes there is checked and recorded before it happens.`;
}

export interface TrustInput {
  /** From the behavior summary: has it stayed inside its limits. */
  standing?: "good" | "attention" | "unknown";
  /** Has the containment self-test actually run for this agent's runs. */
  boundaryProven?: boolean;
  /** Scored runs. Zero means there is nothing to judge on. */
  runs?: number;
  state: AgentLifecycle;
}

/**
 * The line that decides whether someone approves this agent.
 *
 * Ordered by what should stop them. It never says an agent is fine on the
 * strength of an absence of evidence, which is the one way a friendly card
 * could do real damage.
 */
export function trustLine(input: TrustInput): { headline: string; tone: "good" | "attention" | "unknown" } {
  if (input.state === "revoked") {
    return { headline: "Shut off. It cannot act.", tone: "unknown" };
  }
  if (input.standing === "attention") {
    return {
      headline: "Something needs looking at before this agent is given more access.",
      tone: "attention",
    };
  }
  if (!input.runs) {
    return {
      headline: "It has not done anything we have scored yet, so there is nothing to judge it on.",
      tone: "unknown",
    };
  }
  if (input.boundaryProven !== true) {
    // Deliberately not "good". A clean record from a test that never ran is not
    // evidence, and this is the sentence most likely to be over-read.
    return {
      headline: `Nothing has gone wrong across ${input.runs} task${input.runs === 1 ? "" : "s"}, but we have not yet proved its limits hold.`,
      tone: "unknown",
    };
  }
  return {
    headline: `Stayed inside its limits across ${input.runs} task${input.runs === 1 ? "" : "s"}, and its account matched the record.`,
    tone: "good",
  };
}

/** Where the intelligence behind this agent comes from, said plainly. */
export function describeModel(modelId: string | undefined, isClientSupplied: boolean): string {
  if (!modelId) return "No model has been recorded for this agent's work yet.";
  return isClientSupplied
    ? `Runs on ${modelId}, which is your own model. It is governed by exactly the same checks as ours.`
    : `Runs on ${modelId}, supplied and governed by Wolfpack.`;
}

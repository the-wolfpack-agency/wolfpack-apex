/**
 * Agent principal store: create, read, lifecycle, and onboarding-secret
 * verification over instinct_agents (migration 171).
 *
 * The onboarding secret is a high-entropy random value shown once at creation;
 * only its SHA-256 hash is stored, and verification is constant-time. A high
 * entropy machine credential does not need a slow password hash, but it must
 * never be stored or logged in the clear.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { query, writeQuery, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type {
  AgentRecord,
  AgentState,
  AgentIdentityProvider,
} from "./types";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function mapRow(r: Record<string, unknown>): AgentRecord {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name),
    role: String(r.role),
    ownerUserId: String(r.owner_user_id),
    state: String(r.state) as AgentState,
    identityProvider: String(r.identity_provider) as AgentIdentityProvider,
    externalSubject: (r.external_subject as string | null) ?? null,
    scanStatus: (String(r.scan_status) as AgentRecord["scanStatus"]),
    description: (r.description as string | null) ?? null,
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    activatedAt: (r.activated_at as string | null) ?? null,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

const SELECT_COLS = `id, workspace_id, name, role, owner_user_id, state,
  identity_provider, external_subject, scan_status, description, created_by,
  created_at::text AS created_at, activated_at::text AS activated_at,
  last_seen_at::text AS last_seen_at, revoked_at::text AS revoked_at`;

export interface CreateAgentInput {
  workspaceId: string;
  name: string;
  role: string;
  ownerUserId: string;
  createdBy: string;
  createdByRole: string;
  description?: string;
  identityProvider?: AgentIdentityProvider;
}

/**
 * Create an agent principal in the invited state and return the record plus the
 * one-time onboarding secret (shown once, then only its hash is retained).
 */
export async function createAgent(
  input: CreateAgentInput,
): Promise<{ agent: AgentRecord; onboardingSecret: string }> {
  const onboardingSecret = randomBytes(32).toString("hex");
  const provider = input.identityProvider ?? "local";
  const { rows } = await writeQuery<Record<string, unknown>>(
    `INSERT INTO instinct_agents
       (workspace_id, name, role, owner_user_id, identity_provider,
        onboarding_secret_hash, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT_COLS}`,
    [
      input.workspaceId,
      input.name,
      input.role,
      input.ownerUserId,
      provider,
      hashSecret(onboardingSecret),
      input.description ?? null,
      input.createdBy,
    ],
    { expectRows: 1 },
  );
  const agent = mapRow(rows[0]);

  trackEvent("agent.created", input.createdBy, input.createdByRole, {
    agent_id: agent.id,
    role: agent.role,
    owner_user_id: agent.ownerUserId,
    identity_provider: agent.identityProvider,
  });

  return { agent, onboardingSecret };
}

export async function getAgent(
  id: string,
  workspaceId: string,
): Promise<AgentRecord | null> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${SELECT_COLS} FROM instinct_agents WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listAgents(workspaceId: string): Promise<AgentRecord[]> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${SELECT_COLS} FROM instinct_agents
      WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return res.rows.map(mapRow);
}

/** Set lifecycle state (pause, resume, revoke). Returns the updated record. */
export async function setAgentState(
  id: string,
  workspaceId: string,
  state: AgentState,
  actor: { userId: string; role: string },
): Promise<AgentRecord | null> {
  const revokedClause = state === "revoked" ? ", revoked_at = NOW()" : "";
  const res = await writeQuery<Record<string, unknown>>(
    `UPDATE instinct_agents SET state = $3${revokedClause}
      WHERE id = $1 AND workspace_id = $2
      RETURNING ${SELECT_COLS}`,
    [id, workspaceId, state],
  );
  const row = res.rows[0];
  if (!row) return null;
  const agent = mapRow(row);
  trackEvent("agent.lifecycle_changed", actor.userId, actor.role, {
    agent_id: agent.id,
    state,
  });
  return agent;
}

/**
 * Verify a presented onboarding secret for an agent and, on success, transition
 * it to active. Returns the agent record on success, or null on a bad secret, a
 * revoked agent, or an unknown id. Never reveals which of those it was.
 */
export async function activateWithOnboardingSecret(
  agentId: string,
  secret: string,
): Promise<AgentRecord | null> {
  const res = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLS}, onboarding_secret_hash FROM instinct_agents WHERE id = $1`,
    [agentId],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (String(row.state) === "revoked") return null;
  const storedHash = row.onboarding_secret_hash as string | null;
  if (!storedHash) return null;
  if (!constantTimeEqualHex(hashSecret(secret), storedHash)) return null;

  const updated = await writeQuery<Record<string, unknown>>(
    `UPDATE instinct_agents
        SET state = CASE WHEN state = 'invited' THEN 'active' ELSE state END,
            activated_at = COALESCE(activated_at, NOW()),
            last_seen_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLS}`,
    [agentId],
    { expectRows: 1 },
  );
  const agent = mapRow(updated.rows[0]);
  trackEvent("agent.activated", agent.id, agent.role, {
    agent_id: agent.id,
    workspace_id: agent.workspaceId,
  });
  return agent;
}

/** Stamp last_seen_at (called on each successful agent token issue). */
export async function recordAgentSeen(agentId: string): Promise<void> {
  await safeQuery(
    `UPDATE instinct_agents SET last_seen_at = NOW() WHERE id = $1`,
    [agentId],
  );
}

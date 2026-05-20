/**
 * Instinct Auth — Role-based authentication for team members.
 *
 * Roles:
 *   - cto: Full access, architecture decisions, code editing (highest)
 *   - ceo: Full access — same as CTO but read-only on code
 *   - dev: Code Q&A, prototypes, branch creation, docs
 *   - sales: Client docs, proposals, feature requests
 *   - ops: Journals, processes, client comms
 *
 * Auth flow: email + password → JWT → role-scoped access
 */

import { type JwtPayload } from "jsonwebtoken";
import { hashSync, compareSync } from "bcryptjs";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { signToken, verifyToken as cryptoVerifyToken } from "@/lib/crypto/sign";

export type TeamRole = "ceo" | "cto" | "evp" | "vp" | "cco" | "dev" | "sales" | "ops" | "hr";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: TeamRole;
  /** Tenant the member belongs to. Defaults to "default" for the
   *  singleton-workspace deploys that existed before migration 137. */
  workspaceId: string;
  avatar_url?: string;
  created_at: string;
}

/** Singleton-tenant fallback for shadow mode, legacy JWTs, and any
 *  code path that runs before the first workspace row is provisioned. */
export const DEFAULT_WORKSPACE_ID = "default";

export interface AuthResult {
  user: TeamMember;
  token: string;
}

// NOTE: JWT secret validation is now handled in src/lib/crypto/sign.ts.
// This function is kept for backward compatibility with security-hardening tests
// that call it directly via reflection.
export function getJwtSecret(): string {
  // Renamed from Apex → Instinct. Read the new var first, fall back to
  // the legacy var so existing Vercel environments don't break.
  const secret = process.env.INSTINCT_JWT_SECRET ?? process.env.APEX_JWT_SECRET;
  if (secret) {
    if (process.env.NODE_ENV === "production" && secret.length < 32) {
      throw new Error("[auth] JWT secret must be at least 32 characters in production");
    }
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("[auth] INSTINCT_JWT_SECRET (or legacy APEX_JWT_SECRET) must be set in production");
  }
  console.warn("[auth] Using development fallback JWT secret — do not use in production");
  return "instinct-dev-secret-do-not-use-in-production";
}

/** Access-token TTL: 15 minutes */
const JWT_TTL_SECONDS = 15 * 60;

export function hashPassword(password: string): string {
  return hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string): boolean {
  return compareSync(password, hash);
}

export function createToken(user: TeamMember): string {
  return signToken(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      workspaceId: user.workspaceId,
    },
    { ttlSeconds: JWT_TTL_SECONDS },
  );
}

type JwtClaims = JwtPayload & {
  userId: string;
  email: string;
  role: TeamRole;
  name: string;
  /** Optional — legacy JWTs minted before migration 137 don't carry it. */
  workspaceId?: string;
};

export function verifyToken(token: string): JwtClaims {
  const result = cryptoVerifyToken<JwtClaims>(token);
  if (!result.valid) {
    throw new Error(`[auth] Token verification failed: ${result.reason}`);
  }
  return result.payload;
}

/**
 * Authenticate a user by email + password.
 *
 * Email comparison is case-insensitive to match the rest of the codebase
 * (migration 128 created the unique index on LOWER(email); MS-OAuth,
 * forgot-password, whoami, principles team, invite-resend all look up
 * by LOWER(email)). Before 2026-05-20 this route was the lone outlier
 * — operators whose invite stored an uppercase letter (iOS keyboard
 * auto-cap, copy-paste from email signature, etc.) bounced on "Invalid
 * credentials" forever.
 */
export async function authenticate(email: string, password: string): Promise<AuthResult | null> {
  const normalizedEmail = email.trim().toLowerCase();

  if (!process.env.DATABASE_URL) {
    // Shadow mode: demo users
    const demoUsers: Record<string, TeamMember & { password: string }> = {
      "ceo@wolfpack.dev": { id: "demo-ceo", email: "ceo@wolfpack.dev", name: "Demo CEO", role: "ceo", workspaceId: DEFAULT_WORKSPACE_ID, password: "apex", created_at: new Date().toISOString() },
      "cto@wolfpack.dev": { id: "demo-cto", email: "cto@wolfpack.dev", name: "Demo CTO", role: "cto", workspaceId: DEFAULT_WORKSPACE_ID, password: "apex", created_at: new Date().toISOString() },
      "dev@wolfpack.dev": { id: "demo-dev", email: "dev@wolfpack.dev", name: "Demo Dev", role: "dev", workspaceId: DEFAULT_WORKSPACE_ID, password: "apex", created_at: new Date().toISOString() },
      "sales@wolfpack.dev": { id: "demo-sales", email: "sales@wolfpack.dev", name: "Demo Sales", role: "sales", workspaceId: DEFAULT_WORKSPACE_ID, password: "apex", created_at: new Date().toISOString() },
      "ops@wolfpack.dev": { id: "demo-ops", email: "ops@wolfpack.dev", name: "Demo Ops", role: "ops", workspaceId: DEFAULT_WORKSPACE_ID, password: "apex", created_at: new Date().toISOString() },
    };
    const user = demoUsers[normalizedEmail];
    if (user && password === user.password) {
      const { password: _, ...member } = user;
      const token = createToken(member);
      trackEvent("system.login", member.id, member.role, { mode: "shadow" });
      return { user: member, token };
    }
    return null;
  }

  try {
    const result = await query(
      `SELECT id, email, name, role, password_hash, avatar_url, created_at, workspace_id
       FROM instinct_team_members
       WHERE LOWER(email) = $1 AND is_active = true`,
      [normalizedEmail],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (!verifyPassword(password, row.password_hash as string)) return null;

    const user: TeamMember = {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string,
      role: row.role as TeamRole,
      workspaceId: (row.workspace_id as string | null) ?? DEFAULT_WORKSPACE_ID,
      avatar_url: row.avatar_url as string | undefined,
      created_at: row.created_at as string,
    };

    const token = createToken(user);
    trackEvent("system.login", user.id, user.role, { method: "password" });
    return { user, token };
  } catch (err) {
    console.error("[auth] Login error:", (err as Error).message);
    return null;
  }
}

/**
 * Extract and verify user from Authorization header.
 */
export function getUserFromRequest(authHeader: string | null): TeamMember | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = verifyToken(authHeader.slice(7));
    return {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      /* Legacy JWTs minted before migration 137 don't carry workspaceId.
         Fall back to "default" so existing sessions keep working until
         the next login mints a token with the claim. */
      workspaceId: payload.workspaceId ?? DEFAULT_WORKSPACE_ID,
      created_at: "",
    };
  } catch {
    return null;
  }
}

/**
 * Role hierarchy check.
 */
const ROLE_LEVEL: Record<TeamRole, number> = { ceo: 5, cto: 5, evp: 5, vp: 5, cco: 5, hr: 4, dev: 3, ops: 2, sales: 1 };

export function hasRole(userRole: TeamRole, requiredRole: TeamRole): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[requiredRole];
}

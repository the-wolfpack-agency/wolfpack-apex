/**
 * Apex Auth — Role-based authentication for team members.
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

import { sign, verify, type JwtPayload } from "jsonwebtoken";
import { hashSync, compareSync } from "bcryptjs";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type TeamRole = "ceo" | "cto" | "dev" | "sales" | "ops";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: TeamRole;
  avatar_url?: string;
  created_at: string;
}

export interface AuthResult {
  user: TeamMember;
  token: string;
}

function getJwtSecret(): string {
  const secret = process.env.APEX_JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production" && typeof window === "undefined") {
    console.error("[auth] APEX_JWT_SECRET must be set in production — auth will fail");
  }
  return "apex-dev-secret-do-not-use-in-production";
}

const JWT_EXPIRY = "8h";

export function hashPassword(password: string): string {
  return hashSync(password, 12);
}

export function verifyPassword(password: string, hash: string): boolean {
  return compareSync(password, hash);
}

export function createToken(user: TeamMember): string {
  return sign(
    { userId: user.id, email: user.email, role: user.role, name: user.name },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRY },
  );
}

export function verifyToken(token: string): JwtPayload & { userId: string; email: string; role: TeamRole; name: string } {
  return verify(token, getJwtSecret()) as JwtPayload & { userId: string; email: string; role: TeamRole; name: string };
}

/**
 * Authenticate a user by email + password.
 */
export async function authenticate(email: string, password: string): Promise<AuthResult | null> {
  if (!process.env.DATABASE_URL) {
    // Shadow mode: demo users
    const demoUsers: Record<string, TeamMember & { password: string }> = {
      "ceo@wolfpack.dev": { id: "demo-ceo", email: "ceo@wolfpack.dev", name: "Demo CEO", role: "ceo", password: "apex", created_at: new Date().toISOString() },
      "cto@wolfpack.dev": { id: "demo-cto", email: "cto@wolfpack.dev", name: "Demo CTO", role: "cto", password: "apex", created_at: new Date().toISOString() },
      "dev@wolfpack.dev": { id: "demo-dev", email: "dev@wolfpack.dev", name: "Demo Dev", role: "dev", password: "apex", created_at: new Date().toISOString() },
      "sales@wolfpack.dev": { id: "demo-sales", email: "sales@wolfpack.dev", name: "Demo Sales", role: "sales", password: "apex", created_at: new Date().toISOString() },
      "ops@wolfpack.dev": { id: "demo-ops", email: "ops@wolfpack.dev", name: "Demo Ops", role: "ops", password: "apex", created_at: new Date().toISOString() },
    };
    const user = demoUsers[email];
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
      `SELECT id, email, name, role, password_hash, avatar_url, created_at
       FROM apex_team_members
       WHERE email = $1 AND is_active = true`,
      [email],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (!verifyPassword(password, row.password_hash as string)) return null;

    const user: TeamMember = {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string,
      role: row.role as TeamRole,
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
      created_at: "",
    };
  } catch {
    return null;
  }
}

/**
 * Role hierarchy check.
 */
const ROLE_LEVEL: Record<TeamRole, number> = { ceo: 5, cto: 5, dev: 3, ops: 2, sales: 1 };

export function hasRole(userRole: TeamRole, requiredRole: TeamRole): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[requiredRole];
}

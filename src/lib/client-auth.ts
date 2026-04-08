"use client";

/**
 * Client-side auth helpers for Instinct.
 *
 * The platform was renamed from Apex → Instinct. This module provides
 * the canonical names (instinct_token / instinct_user) and reads either
 * the new or the legacy localStorage key so existing logged-in sessions
 * keep working without forcing every user to log in again.
 *
 * EVERY new client component should use these helpers instead of
 * touching localStorage directly.
 */

const TOKEN_KEYS = ["instinct_token", "apex_token"] as const;
const USER_KEYS = ["instinct_user", "apex_user"] as const;

export function getInstinctToken(): string | null {
  if (typeof window === "undefined") return null;
  for (const k of TOKEN_KEYS) {
    const v = localStorage.getItem(k);
    if (v) return v;
  }
  return null;
}

export function getInstinctUser<T = unknown>(): T | null {
  if (typeof window === "undefined") return null;
  for (const k of USER_KEYS) {
    const v = localStorage.getItem(k);
    if (v) {
      try { return JSON.parse(v) as T; } catch { return null; }
    }
  }
  return null;
}

export function setInstinctSession(token: string, user: unknown): void {
  if (typeof window === "undefined") return;
  // Write BOTH the new and legacy keys so any code that hasn't been
  // migrated yet still finds the token. Safe to remove the apex_*
  // writes once nothing reads them anymore.
  localStorage.setItem("instinct_token", token);
  localStorage.setItem("instinct_user", JSON.stringify(user));
  localStorage.setItem("apex_token", token);
  localStorage.setItem("apex_user", JSON.stringify(user));
}

export function clearInstinctSession(): void {
  if (typeof window === "undefined") return;
  for (const k of TOKEN_KEYS) localStorage.removeItem(k);
  for (const k of USER_KEYS) localStorage.removeItem(k);
}

export function authHeaders(): HeadersInit {
  const token = getInstinctToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

"use client";

export function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("apex_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

"use client";

/**
 * QR export beacon. Fired fire-and-forget after a successful download so every
 * export (svg/png/jpg/pdf/eps) becomes a consumed learning signal - no export
 * data lost. Uses the auth-refresh wrapper (raw fetch is forbidden for
 * authenticated routes) and never throws: a failed beacon must not break the
 * download the user just got.
 */
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type { QrFormat } from "./download";

export function reportExport(codeId: string | undefined, format: QrFormat): void {
  if (typeof window === "undefined" || !codeId) return;
  void fetchWithRefresh(`/api/qr/${encodeURIComponent(codeId)}/export`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ format }),
  }).catch(() => {});
}

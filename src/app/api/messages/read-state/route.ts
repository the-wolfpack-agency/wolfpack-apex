/**
 * /api/messages/read-state — per-user-per-chat last-read cursors that
 * drive the bold + dot unread visualization on /messages.
 *
 *   GET  /api/messages/read-state                     → { state: { [chat_id]: ISO } }
 *   GET  /api/messages/read-state?chat_id=X           → { last_read_at: ISO | null }
 *   POST /api/messages/read-state  body { chat_id, last_read_at, kind? }
 *                                                      → { ok: true, last_read_at: ISO }
 *
 * `kind` ∈ "chat" | "channel" | "team" — same table backs all three
 * surfaces; this metadata only feeds the analytics event so dashboards
 * can split adoption per surface. Storage is kind-agnostic.
 *
 * Status codes:
 *   200 happy path on GET / POST
 *   400 POST without `chat_id` or `last_read_at`, or invalid ISO
 *   401 missing or invalid Instinct JWT
 *   500 unexpected DB error
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getReadState,
  setReadState,
  type ReadStateKind,
} from "@/lib/messages/read-state";
import { WriteQueryError } from "@/lib/db";

const VALID_KINDS: ReadonlyArray<ReadStateKind> = ["chat", "channel", "team"];

function asKind(raw: unknown): ReadStateKind {
  return typeof raw === "string" && (VALID_KINDS as readonly string[]).includes(raw)
    ? (raw as ReadStateKind)
    : "chat";
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const chatId = url.searchParams.get("chat_id");

    if (chatId) {
      const map = await getReadState(user.id);
      return NextResponse.json({
        last_read_at: map.get(chatId) ?? null,
      });
    }

    const map = await getReadState(user.id);
    const state: Record<string, string> = {};
    for (const [k, v] of map.entries()) state[k] = v;
    return NextResponse.json({ state });
  } catch (err) {
    console.error("[api/messages/read-state] GET error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json().catch(() => null)) as
      | { chat_id?: unknown; last_read_at?: unknown; kind?: unknown }
      | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid body" },
        { status: 400 },
      );
    }

    const chatId = body.chat_id;
    const lastReadAt = body.last_read_at;
    if (typeof chatId !== "string" || chatId.length === 0) {
      return NextResponse.json(
        { error: "chat_id is required" },
        { status: 400 },
      );
    }
    if (typeof lastReadAt !== "string" || lastReadAt.length === 0) {
      return NextResponse.json(
        { error: "last_read_at is required (ISO 8601)" },
        { status: 400 },
      );
    }
    if (Number.isNaN(Date.parse(lastReadAt))) {
      return NextResponse.json(
        { error: "last_read_at must be a valid ISO 8601 timestamp" },
        { status: 400 },
      );
    }

    const persisted = await setReadState(user.id, chatId, lastReadAt, {
      kind: asKind(body.kind),
      userRole: user.role,
    });
    return NextResponse.json({ ok: true, last_read_at: persisted });
  } catch (err) {
    if (err instanceof WriteQueryError) {
      console.error(
        "[api/messages/read-state] POST write error:",
        err.code,
        err.message,
      );
      return NextResponse.json(
        { error: "Internal error", code: err.code },
        { status: 500 },
      );
    }
    console.error("[api/messages/read-state] POST error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

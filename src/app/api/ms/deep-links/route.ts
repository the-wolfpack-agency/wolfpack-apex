/**
 * GET /api/ms/deep-links — generate a Teams deep-link URL.
 *
 * Query params:
 *   type       = "chat" | "call" | "meet_now"   (required)
 *   email      = recipient email                (required for chat + call)
 *   message    = optional prefill text          (chat only)
 *   with_video = "0" | "1"                      (call only, default 0)
 *
 * Responses:
 *   200 { url: string, type: string }
 *   400 { error: "…" }    — missing / invalid params
 *   401 { error: "Unauthorized" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  chatDeepLink,
  callDeepLink,
  meetNowDeepLink,
} from "@/lib/ms-graph-deep-links";

type DeepLinkType = "chat" | "call" | "meet_now";

function isValidType(v: string | null): v is DeepLinkType {
  return v === "chat" || v === "call" || v === "meet_now";
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const email = url.searchParams.get("email");
    const message = url.searchParams.get("message");
    const withVideoRaw = url.searchParams.get("with_video");

    if (!isValidType(type)) {
      return NextResponse.json(
        { error: "type must be one of: chat, call, meet_now" },
        { status: 400 },
      );
    }

    let deepLink: string;
    try {
      if (type === "chat") {
        if (!email) {
          return NextResponse.json({ error: "email is required for type=chat" }, { status: 400 });
        }
        deepLink = chatDeepLink(email, message || undefined);
      } else if (type === "call") {
        if (!email) {
          return NextResponse.json({ error: "email is required for type=call" }, { status: 400 });
        }
        const withVideo = withVideoRaw === "1" || withVideoRaw === "true";
        deepLink = callDeepLink(email, withVideo);
      } else {
        deepLink = meetNowDeepLink();
      }
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message || "Invalid input" },
        { status: 400 },
      );
    }

    trackEvent("ms_deep_link.generated", user.id, user.role, { type });
    return NextResponse.json({ url: deepLink, type });
  } catch (err) {
    console.error("[api/ms/deep-links] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

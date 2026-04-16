"use client";

/**
 * ChannelMessageReference — compact reference to a specific Teams channel
 * message. Renders "Team: X · Channel: Y · preview …" with a deep link
 * that opens the message in the Teams web app.
 *
 * Fetches from the /api/teams/teams/[id]/channels/[channelId]/messages
 * cache (search by ms_message_id would require a new endpoint; instead
 * callers pass both channel_id and the local message_id so the component
 * can request one page and find the target message).
 *
 * On error (404, unauthorized, scope_missing) the component renders a
 * muted placeholder so it never breaks surrounding layout.
 */

import { useEffect, useState } from "react";

export interface ChannelMessageReferenceProps {
  teamId: string; // local team UUID
  channelId: string; // local channel UUID
  messageId: string; // local message UUID
  className?: string;
  getAuthHeader?: () => string | null;
}

interface TeamShape {
  id: string;
  msTeamId: string;
  displayName: string;
}
interface ChannelShape {
  id: string;
  msChannelId: string;
  displayName: string;
}
interface MessageShape {
  id: string;
  msMessageId: string;
  subject: string | null;
  body: string;
  sender: { displayName?: string };
  createdAt: string;
}

function defaultAuth(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = window.localStorage.getItem("instinct_token");
    return t ? `Bearer ${t}` : null;
  } catch {
    return null;
  }
}

export default function ChannelMessageReference({
  teamId,
  channelId,
  messageId,
  className,
  getAuthHeader,
}: ChannelMessageReferenceProps) {
  const [team, setTeam] = useState<TeamShape | null>(null);
  const [channel, setChannel] = useState<ChannelShape | null>(null);
  const [message, setMessage] = useState<MessageShape | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing" | "error">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const auth = (getAuthHeader ?? defaultAuth)();
        const res = await fetch(
          `/api/teams/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?limit=100`,
          { headers: auth ? { authorization: auth } : undefined },
        );
        if (cancelled) return;
        if (res.status === 404) {
          setStatus("missing");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = (await res.json()) as {
          team?: TeamShape;
          channel?: ChannelShape;
          messages?: MessageShape[];
        };
        if (data.team) setTeam(data.team);
        if (data.channel) setChannel(data.channel);
        const hit = (data.messages ?? []).find((m) => m.id === messageId);
        if (hit) {
          setMessage(hit);
          setStatus("ok");
        } else {
          setStatus("missing");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [teamId, channelId, messageId, getAuthHeader]);

  if (status === "loading") {
    return (
      <span
        className={className}
        style={chipStyle("#eef2ff", "#4338ca")}
        aria-label="Loading Teams channel message"
      >
        Teams channel: loading…
      </span>
    );
  }

  if (status !== "ok" || !team || !channel || !message) {
    return (
      <span
        className={className}
        style={chipStyle("#f3f4f6", "#6b7280")}
        aria-label="Teams channel message unavailable"
      >
        Teams channel: unavailable
      </span>
    );
  }

  const preview = (message.subject || message.body || "").slice(0, 80);
  // Graph returns `webUrl` on messages; we don't roundtrip it through the
  // cache API today, so build a best-effort deep link from the ms ids.
  const teamsUrl =
    `https://teams.microsoft.com/l/message/` +
    `${encodeURIComponent(channel.msChannelId)}/${encodeURIComponent(message.msMessageId)}` +
    `?tenantId=&groupId=${encodeURIComponent(team.msTeamId)}`;

  return (
    <a
      href={teamsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={{
        ...chipStyle("#eef2ff", "#4338ca"),
        textDecoration: "none",
        maxWidth: "100%",
        overflow: "hidden",
      }}
      aria-label={`Open Teams message in ${team.displayName} / ${channel.displayName}`}
      data-testid="channel-message-reference"
    >
      <span style={{ fontWeight: 600 }}>Team: {team.displayName}</span>
      <span style={{ opacity: 0.7 }}>·</span>
      <span>Channel: {channel.displayName}</span>
      {preview && (
        <>
          <span style={{ opacity: 0.7 }}>·</span>
          <span style={{ opacity: 0.9 }}>{preview}</span>
        </>
      )}
    </a>
  );
}

function chipStyle(bg: string, fg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 8px",
    borderRadius: 12,
    background: bg,
    color: fg,
    fontSize: 12,
  };
}

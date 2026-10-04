"use client";
/**
 * A neon-outline chat bubble that floats on the page. Minimal: a transparent fill
 * with a glowing 1px border. The user's turn is accent-tinted and right-aligned;
 * the factory's response is left-aligned and holds the widgets (passed as children).
 */
import type { ReactNode } from "react";
import { NEON, neonGlow } from "./neon";

export default function ChatBubble({
  role, children, testid,
}: { role: "user" | "factory"; children: ReactNode; testid?: string }): React.ReactElement {
  const isUser = role === "user";
  const edge = isUser ? NEON.accent : NEON.accentDim;
  return (
    <div
      data-testid={testid ?? `bubble-${role}`}
      style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", width: "100%" }}
    >
      <div
        style={{
          maxWidth: isUser ? "80%" : "92%",
          background: NEON.surface,
          backdropFilter: "blur(6px)",
          border: `1px solid ${edge}`,
          boxShadow: neonGlow(edge),
          borderRadius: 14,
          padding: isUser ? "0.6rem 0.9rem" : "0.85rem 1rem",
          color: NEON.text,
          fontSize: "0.9rem",
          lineHeight: 1.5,
        }}
      >
        {children}
      </div>
    </div>
  );
}

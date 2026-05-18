"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

/**
 * CodeBlock — fenced code block surface for the assistant chat.
 *
 * Renders a header strip (language label left, Copy button right) and a
 * pre/code body. Mirrors the ChatGPT pattern. Intentionally no syntax
 * highlighting — keeps zero runtime deps, keeps the bundle small.
 *
 * Analytics: every copy fires `assistant.code_copied` through the same
 * fire-and-forget `/api/analytics` POST the rest of the chat surface
 * uses (see InstinctChat.tsx for the canonical call site we mirror).
 *
 * Security: the `code` prop is rendered as a text node inside
 * `<code>` — never `dangerouslySetInnerHTML` — so backticked content
 * can't smuggle HTML/JS into the DOM.
 */

interface CodeBlockProps {
  /** Raw code text. Rendered verbatim. */
  code: string;
  /** Optional language tag from the fence (e.g. "ts", "python"). When
   *  blank/missing we display "code". Always lowercased before display. */
  language?: string;
}

const COPIED_FEEDBACK_MS = 1500;

function trackCodeCopied(language: string, codeLength: number): void {
  if (typeof window === "undefined") return;
  void fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      event: "assistant.code_copied",
      metadata: {
        language,
        code_length: codeLength,
        page: window.location.pathname,
      },
    }),
  }).catch(() => {
    /* non-fatal — analytics must never break UX */
  });
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const displayLanguage = (language || "code").toLowerCase();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear pending timeout if the component unmounts mid-feedback to
  // avoid setState-on-unmounted warnings in dev / tests.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      // navigator.clipboard may be undefined in some environments
      // (HTTP, ancient browsers, jsdom without a stub). Guard
      // gracefully — the user just doesn't see "Copied".
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
      setCopied(true);
      trackCodeCopied(displayLanguage, code.length);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, COPIED_FEEDBACK_MS);
    } catch {
      /* clipboard.writeText can reject (permissions, focus). Swallow —
       * the user can re-select the code manually. */
    }
  }, [code, displayLanguage]);

  return (
    <div
      data-testid="assistant-code-block"
      data-language={displayLanguage}
      style={{
        background: "var(--wp-dark, #111)",
        border: "1px solid var(--wp-border, #333)",
        borderRadius: "6px",
        overflow: "hidden",
        margin: "8px 0",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 10px",
          background: "var(--wp-dark-surface2, #222)",
          fontSize: "12px",
        }}
      >
        <span
          data-testid="assistant-code-language"
          style={{
            color: "var(--wp-text-muted, #6b7280)",
            textTransform: "lowercase",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          }}
        >
          {displayLanguage}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          data-testid="assistant-code-copy"
          aria-label={copied ? "Copied" : "Copy code"}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--wp-text-muted, #6b7280)",
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: "12px",
            borderRadius: "4px",
            transition: "color 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--wp-gold, #eab308)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--wp-text-muted, #6b7280)";
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "12px",
          overflowX: "auto",
          fontSize: "13px",
          lineHeight: 1.5,
          color: "var(--wp-text, #e5e7eb)",
          background: "var(--wp-dark, #111)",
          whiteSpace: "pre",
        }}
      >
        <code
          data-testid="assistant-code-body"
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          }}
        >
          {code}
        </code>
      </pre>
    </div>
  );
}

export default CodeBlock;

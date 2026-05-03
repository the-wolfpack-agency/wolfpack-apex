/**
 * src/lib/obs/console-backend — default backend, always on.
 *
 * Emits structured JSON to stdout/stderr so it's grep-able from logs
 * and trivially parseable by Vercel log drains until a real backend
 * is configured.
 *
 * Verbosity is controlled by OBS_LEVEL:
 *   - 'verbose'     — every span + every error
 *   - 'default'     — spans with status='error' OR duration > 250ms,
 *                     plus all errors (sensible production default)
 *   - 'errors-only' — only status='error' spans + recordError calls
 *
 * Anything outside these values falls back to 'default'.
 */

import { createHash } from "node:crypto";

import type {
  ObservabilityBackend,
  Span,
  SpanAttributes,
  SpanError,
} from "./types";

type ObsLevel = "verbose" | "default" | "errors-only";

const SLOW_SPAN_THRESHOLD_MS = 250;

/* Defense-in-depth: callers SHOULD NOT pass secrets through span
   attributes, but in practice tokens, refresh_tokens, and passwords
   leak in via metadata copies. This redactor swaps any attribute whose
   key looks secret-shaped for a short sha256 fingerprint, which is
   enough to correlate two log lines without ever printing the secret
   in cleartext. */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|authorization|cookie|session|refresh)/i;

function fingerprint(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return "sha256:" + createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function redactAttributes(attrs: SpanAttributes | undefined): SpanAttributes {
  if (!attrs) return {};
  const out: SpanAttributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SECRET_KEY_RE.test(k) && v !== null && v !== undefined && v !== "") {
      out[k] = fingerprint(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readLevel(): ObsLevel {
  const raw = (process.env.OBS_LEVEL ?? "").toLowerCase();
  if (raw === "verbose" || raw === "default" || raw === "errors-only") {
    return raw;
  }
  return "default";
}

function shouldEmitSpan(span: Span, level: ObsLevel): boolean {
  if (level === "verbose") return true;
  if (span.status === "error") return true;
  if (level === "errors-only") return false;
  // 'default'
  const duration = span.endTime - span.startTime;
  return duration >= SLOW_SPAN_THRESHOLD_MS;
}

export class ConsoleBackend implements ObservabilityBackend {
  readonly name = "console";

  recordSpan(span: Span): void {
    try {
      const level = readLevel();
      if (!shouldEmitSpan(span, level)) return;
      const payload = {
        kind: "span",
        name: span.name,
        status: span.status,
        duration_ms: span.endTime - span.startTime,
        start_time: span.startTime,
        end_time: span.endTime,
        attributes: redactAttributes(span.attributes),
        error: span.error,
      };
      const line = JSON.stringify(payload);
      if (span.status === "error") {
        console.error(line);
      } else {
        console.log(line);
      }
    } catch {
      /* observability must never throw */
    }
  }

  recordError(error: SpanError, attrs?: SpanAttributes): void {
    try {
      const level = readLevel();
      // recordError ALWAYS emits — that's the whole point of this hook.
      // Level only suppresses span chatter.
      void level;
      const payload = {
        kind: "error",
        error,
        attributes: redactAttributes(attrs),
      };
      console.error(JSON.stringify(payload));
    } catch {
      /* observability must never throw */
    }
  }

  async flush(): Promise<void> {
    // console is synchronous; nothing to flush.
  }
}

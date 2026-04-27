/**
 * src/lib/obs/router — multi-backend orchestrator (singleton).
 *
 * One ObsClient fans out to every configured backend:
 *   - ConsoleBackend  — always mounted (dev + prod fallback)
 *   - AppInsightsBackend — mounted whenever
 *     APPLICATIONINSIGHTS_CONNECTION_STRING is set
 *
 * Backends are instantiated lazily on first use so importing this
 * module from a static path does not connect to anything.
 *
 * Hard rule: this file MUST NOT throw from any public method.
 * Observability failures must never crash the host app. We isolate
 * each backend call in a try/catch and surface failures via
 * console.warn.
 */

import { ConsoleBackend } from "./console-backend";
import { AppInsightsBackend } from "./app-insights-backend";
import type {
  ObservabilityBackend,
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanError,
  SpanHandle,
  SpanStatus,
} from "./types";

function toSpanError(err: unknown): SpanError {
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }
  return { message: String(err) };
}

function isAppInsightsConfigured(): boolean {
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  return typeof conn === "string" && conn.length > 0;
}

export class ObsClient {
  private backends: ObservabilityBackend[] | null = null;

  private getBackends(): ObservabilityBackend[] {
    if (this.backends) return this.backends;
    const list: ObservabilityBackend[] = [new ConsoleBackend()];
    if (isAppInsightsConfigured()) {
      list.push(new AppInsightsBackend());
    }
    this.backends = list;
    return list;
  }

  /**
   * Test-only: clear the cached backend list so env-var changes are
   * reflected on the next startSpan / recordError call. Public so
   * tests can poke at it; production code never calls this.
   */
  _resetForTests(): void {
    this.backends = null;
  }

  startSpan(name: string, attrs?: SpanAttributes): SpanHandle {
    const startTime = Date.now();
    const liveAttrs: SpanAttributes = { ...(attrs ?? {}) };
    let ended = false;

    const dispatch = (span: Span) => {
      for (const backend of this.getBackends()) {
        try {
          backend.recordSpan(span);
        } catch (err) {
          // observability failures must never crash the app
          try {
            console.warn(
              `[obs] backend ${backend.name} threw on recordSpan: ${(err as Error).message}`,
            );
          } catch {
            /* swallow */
          }
        }
      }
    };

    return {
      setAttribute: (key: string, value: SpanAttributeValue) => {
        if (ended) return;
        liveAttrs[key] = value;
      },
      end: (status: SpanStatus = "ok", endAttrs?: SpanAttributes) => {
        if (ended) return;
        ended = true;
        if (endAttrs) {
          for (const [k, v] of Object.entries(endAttrs)) {
            liveAttrs[k] = v;
          }
        }
        const span: Span = {
          name,
          startTime,
          endTime: Date.now(),
          attributes: liveAttrs,
          status,
        };
        dispatch(span);
      },
    };
  }

  recordError(error: Error, attrs?: SpanAttributes): void {
    const spanError = toSpanError(error);
    for (const backend of this.getBackends()) {
      try {
        backend.recordError(spanError, attrs);
      } catch (err) {
        try {
          console.warn(
            `[obs] backend ${backend.name} threw on recordError: ${(err as Error).message}`,
          );
        } catch {
          /* swallow */
        }
      }
    }
  }

  /**
   * Convenience wrapper: starts a span around fn, records duration,
   * sets status='ok' on success or status='error' on throw, and
   * re-throws so call-site behavior is unchanged.
   *
   * The error span carries `error.message` and `error.name` as
   * attributes for easy querying in App Insights / log search.
   */
  async wrap<T>(
    name: string,
    fn: () => Promise<T>,
    attrs?: SpanAttributes,
  ): Promise<T> {
    const handle = this.startSpan(name, attrs);
    try {
      const result = await fn();
      handle.end("ok");
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      handle.setAttribute("error_message", e.message);
      handle.setAttribute("error_name", e.name);
      handle.end("error");
      this.recordError(e, attrs);
      throw err;
    }
  }

  async flush(): Promise<void> {
    for (const backend of this.getBackends()) {
      try {
        await backend.flush();
      } catch (err) {
        try {
          console.warn(
            `[obs] backend ${backend.name} threw on flush: ${(err as Error).message}`,
          );
        } catch {
          /* swallow */
        }
      }
    }
  }
}

let cached: ObsClient | null = null;

export function getObsClient(): ObsClient {
  if (cached) return cached;
  cached = new ObsClient();
  return cached;
}

export function _resetObsClientForTests(): void {
  cached = null;
}

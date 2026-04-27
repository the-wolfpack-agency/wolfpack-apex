/**
 * src/lib/obs/types — provider-neutral observability shapes.
 *
 * Every backend (console for dev, Application Insights for prod, OTel
 * later) implements ObservabilityBackend. Per-call sites speak in
 * Span / SpanError only and never depend on a specific SDK.
 *
 * Conventions:
 *   - Times are unix-epoch milliseconds (Date.now()).
 *   - Attributes are flat key/value maps. Nested objects are not
 *     guaranteed to round-trip through every backend, so callers
 *     should keep values primitive-ish.
 *   - status='error' implies error is set; status='ok' implies it is
 *     not. Backends MAY enforce this.
 */

export type SpanStatus = "ok" | "error";

export type SpanAttributeValue = string | number | boolean | null | undefined;

export type SpanAttributes = Record<string, SpanAttributeValue>;

export interface SpanError {
  message: string;
  stack?: string;
  name?: string;
}

export interface Span {
  name: string;
  startTime: number;
  endTime: number;
  attributes: SpanAttributes;
  status: SpanStatus;
  error?: SpanError;
}

/**
 * Backend contract. Implementations MUST NOT throw from these
 * methods — observability failures must never crash the host app.
 * Surface failures via console.warn instead.
 */
export interface ObservabilityBackend {
  readonly name: string;
  recordSpan(span: Span): void;
  recordError(error: SpanError, attrs?: SpanAttributes): void;
  flush(): Promise<void>;
}

/**
 * Handle returned by startSpan. Calling .end() finalizes the span and
 * dispatches it to all configured backends.
 */
export interface SpanHandle {
  setAttribute(key: string, value: SpanAttributeValue): void;
  end(status?: SpanStatus, attrs?: SpanAttributes): void;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

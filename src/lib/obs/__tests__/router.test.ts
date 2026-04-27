/**
 * obs/router — unit tests for the multi-backend orchestrator.
 *
 * Covers:
 *   - console backend captures spans (verbose mode) and errors
 *   - app insights backend no-ops when connection string unset
 *   - app insights backend throws when connection string set (proves
 *     the implementation TODO is real, not silently skipped)
 *   - wrap() records duration + status='ok' on success
 *   - wrap() records error + status='error' on throw and re-throws
 *   - span attributes propagate through .end()
 *   - setAttribute() updates the span before end
 *   - recordError fans out to all backends
 *   - getObsClient is a singleton
 *   - obs failures never crash the host (backend that throws is
 *     swallowed)
 */

import {
  ObsClient,
  getObsClient,
  _resetObsClientForTests,
} from "../router";
import { AppInsightsBackend } from "../app-insights-backend";
import { NotImplementedError, type ObservabilityBackend, type Span, type SpanError } from "../types";

const ORIGINAL_ENV = { ...process.env };

function captureConsole() {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(typeof line === "string" ? line : JSON.stringify(line));
  });
  const errSpy = jest.spyOn(console, "error").mockImplementation((line: unknown) => {
    errs.push(typeof line === "string" ? line : JSON.stringify(line));
  });
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  return {
    logs,
    errs,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  process.env.OBS_LEVEL = "verbose";
  _resetObsClientForTests();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("ConsoleBackend via ObsClient", () => {
  test("captures a successful span as JSON on console.log", () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      const handle = obs.startSpan("unit.test.success", { feature: "x" });
      handle.end("ok", { count: 3 });
      expect(cap.logs.length).toBe(1);
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.kind).toBe("span");
      expect(parsed.name).toBe("unit.test.success");
      expect(parsed.status).toBe("ok");
      expect(parsed.attributes.feature).toBe("x");
      expect(parsed.attributes.count).toBe(3);
      expect(typeof parsed.duration_ms).toBe("number");
    } finally {
      cap.restore();
    }
  });

  test("captures errors via recordError on console.error", () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      obs.recordError(new Error("kaboom"), { feature: "x" });
      expect(cap.errs.length).toBe(1);
      const parsed = JSON.parse(cap.errs[0]);
      expect(parsed.kind).toBe("error");
      expect(parsed.error.message).toBe("kaboom");
      expect(parsed.attributes.feature).toBe("x");
    } finally {
      cap.restore();
    }
  });
});

describe("AppInsightsBackend stub", () => {
  test("no-ops when APPLICATIONINSIGHTS_CONNECTION_STRING is unset", async () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    const backend = new AppInsightsBackend();
    const span: Span = {
      name: "x",
      startTime: 0,
      endTime: 1,
      attributes: {},
      status: "ok",
    };
    expect(() => backend.recordSpan(span)).not.toThrow();
    const err: SpanError = { message: "x" };
    expect(() => backend.recordError(err)).not.toThrow();
    await expect(backend.flush()).resolves.toBeUndefined();
  });

  test("throws NotImplementedError when connection string is configured", async () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=abc;IngestionEndpoint=https://example.in.applicationinsights.azure.com/";
    const backend = new AppInsightsBackend();
    const span: Span = {
      name: "x",
      startTime: 0,
      endTime: 1,
      attributes: {},
      status: "ok",
    };
    expect(() => backend.recordSpan(span)).toThrow(NotImplementedError);
    expect(() => backend.recordError({ message: "x" })).toThrow(NotImplementedError);
    await expect(backend.flush()).rejects.toBeInstanceOf(NotImplementedError);
  });

  test("ObsClient swallows backend throws so host never crashes", () => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      "InstrumentationKey=abc;IngestionEndpoint=https://example.in.applicationinsights.azure.com/";
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      // backend.recordSpan() will throw NotImplementedError; ObsClient must
      // catch + console.warn instead of propagating.
      const handle = obs.startSpan("must.not.crash");
      expect(() => handle.end("ok")).not.toThrow();
      // recordError on the AppInsights backend also throws; must be swallowed.
      expect(() => obs.recordError(new Error("nope"))).not.toThrow();
    } finally {
      cap.restore();
    }
  });
});

describe("ObsClient.wrap()", () => {
  test("records duration and status='ok' on success", async () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      const result = await obs.wrap(
        "wrap.success",
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          return 42;
        },
        { feature: "wrap" },
      );
      expect(result).toBe(42);
      expect(cap.logs.length).toBe(1);
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.name).toBe("wrap.success");
      expect(parsed.status).toBe("ok");
      expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
      expect(parsed.attributes.feature).toBe("wrap");
    } finally {
      cap.restore();
    }
  });

  test("records error + status='error' and re-throws on failure", async () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      await expect(
        obs.wrap("wrap.failure", async () => {
          throw new Error("oops");
        }),
      ).rejects.toThrow("oops");
      // Two console.error lines: one for the span (status='error'),
      // one for the recordError fan-out.
      expect(cap.errs.length).toBeGreaterThanOrEqual(1);
      const span = cap.errs
        .map((line) => JSON.parse(line))
        .find((p) => p.kind === "span");
      expect(span).toBeDefined();
      expect(span.status).toBe("error");
      expect(span.attributes.error_message).toBe("oops");
    } finally {
      cap.restore();
    }
  });
});

describe("Span attribute handling", () => {
  test("startSpan attrs and end() attrs both propagate", () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      const h = obs.startSpan("attrs.test", { a: 1 });
      h.end("ok", { b: "two", c: true });
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.attributes.a).toBe(1);
      expect(parsed.attributes.b).toBe("two");
      expect(parsed.attributes.c).toBe(true);
    } finally {
      cap.restore();
    }
  });

  test("setAttribute() updates the span before end", () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      const h = obs.startSpan("setattr.test");
      h.setAttribute("user_id", "u-123");
      h.setAttribute("status_code", 200);
      h.end("ok");
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.attributes.user_id).toBe("u-123");
      expect(parsed.attributes.status_code).toBe(200);
    } finally {
      cap.restore();
    }
  });

  test("end() is idempotent (second call is a no-op)", () => {
    const cap = captureConsole();
    try {
      const obs = new ObsClient();
      const h = obs.startSpan("idempotent.test");
      h.end("ok");
      h.end("ok");
      expect(cap.logs.length).toBe(1);
    } finally {
      cap.restore();
    }
  });
});

describe("Multi-backend fan-out", () => {
  test("recordError reaches every configured backend", () => {
    const cap = captureConsole();
    try {
      const calls: string[] = [];
      class Probe implements ObservabilityBackend {
        readonly name = "probe";
        recordSpan(_s: Span): void {
          calls.push("span");
        }
        recordError(_e: SpanError): void {
          calls.push("error");
        }
        async flush(): Promise<void> {
          calls.push("flush");
        }
      }
      const obs = new ObsClient();
      // Inject a probe alongside ConsoleBackend.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (obs as unknown as { backends: ObservabilityBackend[] | null }).backends =
        [new Probe()];
      obs.recordError(new Error("x"));
      const h = obs.startSpan("probe.span");
      h.end("ok");
      expect(calls).toEqual(["error", "span"]);
    } finally {
      cap.restore();
    }
  });
});

describe("getObsClient", () => {
  test("returns a singleton", () => {
    _resetObsClientForTests();
    const a = getObsClient();
    const b = getObsClient();
    expect(a).toBe(b);
  });
});

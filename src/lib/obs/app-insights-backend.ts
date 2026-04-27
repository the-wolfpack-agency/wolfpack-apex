/**
 * src/lib/obs/app-insights-backend — Azure Application Insights stub.
 *
 * Today this backend is a stub. It is mounted in the router whenever
 * APPLICATIONINSIGHTS_CONNECTION_STRING is set. The intent is that
 * when the Azure card lands and the connection string is configured
 * in Vercel, ALL we need to change is this file — the rest of the
 * codebase already speaks the obs.* API.
 *
 * Implementation plan when the connection string lands:
 *
 *   1. Add `applicationinsights` to package.json (Node SDK; for
 *      browser code we'd use `@microsoft/applicationinsights-web`,
 *      but Instinct's obs surface is server-side today).
 *
 *   2. Lazy-init the client on first call:
 *
 *        import * as appInsights from "applicationinsights";
 *        appInsights.setup(connStr)
 *          .setAutoCollectRequests(false)   // we own the spans
 *          .setAutoCollectExceptions(false) // we own the errors
 *          .setSendLiveMetrics(false)
 *          .start();
 *        const client = appInsights.defaultClient;
 *
 *   3. recordSpan -> client.trackDependency({
 *        name: span.name,
 *        duration: span.endTime - span.startTime,
 *        success: span.status === 'ok',
 *        properties: span.attributes,
 *        ...
 *      })
 *      For incoming HTTP spans (api.GET.foo) prefer trackRequest.
 *
 *   4. recordError -> client.trackException({
 *        exception: new Error(error.message),
 *        properties: { ...attrs, name: error.name, stack: error.stack },
 *      })
 *
 *   5. flush -> new Promise<void>(resolve => client.flush({
 *        callback: () => resolve(),
 *      }))
 *
 * Until then the backend is intentionally a no-op when unconfigured
 * (so wiring it up is safe today) and a loud failure when configured
 * (so we can't accidentally ship a half-implementation).
 */

import {
  type ObservabilityBackend,
  type Span,
  type SpanAttributes,
  type SpanError,
  NotImplementedError,
} from "./types";

function isConfigured(): boolean {
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  return typeof conn === "string" && conn.length > 0;
}

export class AppInsightsBackend implements ObservabilityBackend {
  readonly name = "app-insights";

  recordSpan(_span: Span): void {
    if (!isConfigured()) return;
    throw new NotImplementedError(
      "App Insights backend stub. Implement when connection string is configured.",
    );
  }

  recordError(_error: SpanError, _attrs?: SpanAttributes): void {
    if (!isConfigured()) return;
    throw new NotImplementedError(
      "App Insights backend stub. Implement when connection string is configured.",
    );
  }

  async flush(): Promise<void> {
    if (!isConfigured()) return;
    throw new NotImplementedError(
      "App Insights backend stub. Implement when connection string is configured.",
    );
  }
}

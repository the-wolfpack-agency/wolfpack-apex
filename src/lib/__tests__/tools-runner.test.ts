/**
 * tools-runner lib tests — focused on the log-parsing path inside
 * getRunStatus(). The workflow emits a `TOOL_RESULT_B64=<base64>` line for
 * every completed run; the lib reads the job log and decodes that marker.
 * When the marker is absent (older runs), it falls back to a multi-line
 * JSON regex.
 *
 * These tests mock global fetch so we can drive arbitrary log bodies
 * through the parser without any GitHub Actions round-trip.
 */

import { getRunStatus } from "@/lib/tools-runner";

type FetchMock = jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function textResponse(text: string, init: ResponseInit = {}) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...init,
  });
}

function installFetch(responses: Array<(url: string) => Response | Promise<Response>>): FetchMock {
  const mock = jest.fn(async (url: RequestInfo | URL) => {
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch: ${String(url)}`);
    return next(String(url));
  }) as unknown as FetchMock;
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

/** Encode a result the way tools-runner.yml does: `cat` raw JSON then base64. */
function encodeMarker(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

/** Wrap each line with a GitHub Actions timestamp prefix like the real log. */
function withTimestamps(body: string): string {
  return body
    .split("\n")
    .map((l, i) => `2026-04-17T17:48:${String(49 + i).padStart(2, "0")}.000Z ${l}`)
    .join("\n");
}

function stubRunCompleted() {
  return jsonResponse({
    id: 42,
    status: "completed",
    conclusion: "success",
    created_at: "2026-04-17T17:48:00Z",
    updated_at: "2026-04-17T17:49:30Z",
  });
}

function stubJobs() {
  return jsonResponse({ jobs: [{ id: 7, steps: [] }] });
}

describe("tools-runner getRunStatus — log parsing", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("parses the TOOL_RESULT_B64 marker from the job log", async () => {
    const payload = { status: "complete", message: "Report generated", report_url: "https://x" };
    const log = withTimestamps(
      ["starting tool", `TOOL_RESULT_B64=${encodeMarker(payload)}`, "done"].join("\n"),
    );

    installFetch([
      () => stubRunCompleted(),
      () => stubJobs(),
      () => textResponse(log),
    ]);

    const status = await getRunStatus(42, "fake-token");
    expect(status.status).toBe("completed");
    expect(status.result).toEqual(payload);
  });

  it("parses a multi-line JSON block when the marker is absent (backward compat)", async () => {
    const payload = { status: "complete", findings: [{ id: "a" }, { id: "b" }] };
    const prettyJson = JSON.stringify(payload, null, 2);
    const log = withTimestamps(["tool start", prettyJson, "tool end"].join("\n"));

    installFetch([
      () => stubRunCompleted(),
      () => stubJobs(),
      () => textResponse(log),
    ]);

    const status = await getRunStatus(42, "fake-token");
    expect(status.status).toBe("completed");
    expect(status.result).toEqual(payload);
  });

  it("returns completed with undefined result if the log contains no parseable payload", async () => {
    const log = withTimestamps("just some noise with no JSON\nand no marker either");

    installFetch([
      () => stubRunCompleted(),
      () => stubJobs(),
      () => textResponse(log),
    ]);

    const status = await getRunStatus(42, "fake-token");
    expect(status.status).toBe("completed");
    expect(status.result).toBeUndefined();
  });

  it("prefers the base64 marker over a malformed JSON block earlier in the log", async () => {
    // A multi-line block that matches the regex but cannot JSON.parse
    // (trailing comma is invalid JSON). The regex fallback would choke;
    // the base64 marker must still win.
    const payload = { status: "complete", ok: true };
    const malformed = `{\n  "status": "complete",\n  "bad": 1,\n}`;
    const log = withTimestamps(
      [malformed, `TOOL_RESULT_B64=${encodeMarker(payload)}`].join("\n"),
    );

    installFetch([
      () => stubRunCompleted(),
      () => stubJobs(),
      () => textResponse(log),
    ]);

    const status = await getRunStatus(42, "fake-token");
    expect(status.result).toEqual(payload);
  });

  it("reports failed status when the workflow conclusion is not success", async () => {
    installFetch([
      () =>
        jsonResponse({
          id: 42,
          status: "completed",
          conclusion: "failure",
          created_at: "2026-04-17T17:48:00Z",
          updated_at: "2026-04-17T17:49:30Z",
        }),
    ]);

    const status = await getRunStatus(42, "fake-token");
    expect(status.status).toBe("failed");
    expect(status.error).toContain("failure");
    // Even on failure, the run_url must be set so humans can click through
    // to the GitHub Actions run and see what actually happened. An audit
    // row without a traceable link is the "dishonest product" we're
    // trying to prevent.
    expect(status.run_url).toBe("https://github.com/the-wolfpack-agency/wolfpack-apex/actions/runs/42");
  });
});

/* ── Vibium honesty matrix: artifact contract parsing ─────────────── */

describe("tools-runner getRunStatus — artifact contract", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function runWithPayload(payload: unknown) {
    const log = withTimestamps(`TOOL_RESULT_B64=${encodeMarker(payload)}`);
    installFetch([
      () => stubRunCompleted(),
      () => stubJobs(),
      () => textResponse(log),
    ]);
    return getRunStatus(42, "fake-token");
  }

  it("surfaces a well-formed artifacts manifest at the top level", async () => {
    const payload = {
      status: "complete",
      artifacts: [
        {
          name: "report.pdf",
          kind: "pdf",
          path: "/tmp/tool-results/report.pdf",
          size_bytes: 12345,
          sha256: "a".repeat(64),
        },
      ],
    };
    const status = await runWithPayload(payload);
    expect(status.artifacts).toHaveLength(1);
    expect(status.artifacts?.[0]).toMatchObject({
      name: "report.pdf",
      kind: "pdf",
      sha256: "a".repeat(64),
    });
    expect(status.run_url).toMatch(/^https:\/\/github\.com\/.+\/actions\/runs\/42$/);
  });

  it("rejects an artifacts manifest with missing required fields", async () => {
    const payload = {
      status: "complete",
      artifacts: [{ name: "no-hash.pdf", kind: "pdf", path: "/tmp/x" /* size_bytes + sha256 missing */ }],
    };
    const status = await runWithPayload(payload);
    expect(status.result).toBeDefined();
    // Malformed manifest must NOT surface as a trusted artifact list —
    // otherwise a buggy tool could claim output that was never produced.
    expect(status.artifacts).toBeUndefined();
  });

  it("rejects an artifacts value that isn't an array", async () => {
    const payload = { status: "complete", artifacts: "oops" };
    const status = await runWithPayload(payload);
    expect(status.artifacts).toBeUndefined();
  });

  it("returns undefined artifacts when the result has no artifacts field at all", async () => {
    const payload = { status: "complete", message: "legacy result from before artifacts existed" };
    const status = await runWithPayload(payload);
    expect(status.artifacts).toBeUndefined();
    expect(status.result).toBeDefined();
  });
});

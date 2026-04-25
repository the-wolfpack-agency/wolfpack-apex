/**
 * Contract tests for POST /api/automations/porsche-classes/manual-ingest.
 *
 * Locks in:
 *   - 401/403 from the capability gate
 *   - 400 on missing source_type / file / unsupported source_type / empty file
 *   - happy path: forwards bytes to ingestArtifact with a synthetic
 *     `manual:<userId>:<ts>` source_message_id
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockIngestArtifact = jest.fn();
jest.mock("@/lib/automations/porsche-classes/ingest", () => ({
  ingestArtifact: (...a: unknown[]) => mockIngestArtifact(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/automations/porsche-classes/manual-ingest/route";

function allow(role = "ops", userId = "u-1") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: userId, email: "x@example.com", name: "x", role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function deny(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

function multipart(form: FormData): NextRequest {
  /* NextRequest reads the FormData parser off the underlying Request,
     which Node's undici implementation handles natively when we hand
     it a FormData body. No content-type header needed — fetch sets it
     with the boundary. */
  return new NextRequest("http://x/api/automations/porsche-classes/manual-ingest", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  mockRequireCapability.mockReset();
  mockIngestArtifact.mockReset();
});

describe("POST /api/automations/porsche-classes/manual-ingest", () => {
  it("returns 401 when the capability gate denies", async () => {
    deny(401, "no token");
    const r = await POST(multipart(new FormData()));
    expect(r.status).toBe(401);
  });

  it("returns 403 when the user lacks automations.run", async () => {
    deny(403, "missing automations.run");
    const r = await POST(multipart(new FormData()));
    expect(r.status).toBe(403);
  });

  it("returns 400 when source_type is missing", async () => {
    allow();
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "a.xlsx"),
    );
    const r = await POST(multipart(form));
    expect(r.status).toBe(400);
  });

  it("returns 400 when source_type is unsupported", async () => {
    allow();
    const form = new FormData();
    form.append("source_type", "email");
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "a.xlsx"),
    );
    const r = await POST(multipart(form));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/unsupported source_type/);
  });

  it("returns 400 when file is missing", async () => {
    allow();
    const form = new FormData();
    form.append("source_type", "survey");
    const r = await POST(multipart(form));
    expect(r.status).toBe(400);
  });

  it("returns 400 when file is empty", async () => {
    allow();
    const form = new FormData();
    form.append("source_type", "survey");
    form.append("file", new File([new Uint8Array([])], "empty.xlsx"));
    const r = await POST(multipart(form));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/empty/);
  });

  it("forwards bytes to ingestArtifact with a synthetic manual:* message id", async () => {
    allow("ops", "user-42");
    mockIngestArtifact.mockResolvedValueOnce({
      artifact_id: "art-1",
      was_duplicate: false,
      parse_status: "processed",
      snapshots_written: 1,
      deltas_written: 0,
    });
    const form = new FormData();
    form.append("source_type", "survey");
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3, 4])], "BA101_Apr20_Ritz.xlsx"),
    );
    const r = await POST(multipart(form));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; result: { snapshots_written: number } };
    expect(body.ok).toBe(true);
    expect(body.result.snapshots_written).toBe(1);

    expect(mockIngestArtifact).toHaveBeenCalledTimes(1);
    const call = mockIngestArtifact.mock.calls[0][0] as {
      source_type: string;
      source_message_id: string;
      hint: string;
      bytes: Buffer;
      user_id: string;
    };
    expect(call.source_type).toBe("survey");
    expect(call.source_message_id).toMatch(/^manual:user-42:\d+$/);
    expect(call.hint).toBe("BA101_Apr20_Ritz.xlsx");
    expect(call.user_id).toBe("user-42");
    expect(call.bytes).toBeInstanceOf(Buffer);
    expect(call.bytes.length).toBe(4);
  });
});

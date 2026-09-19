/** @jest-environment node */
import { NextRequest } from "next/server";

const getHarnessReading = jest.fn();
jest.mock("@/lib/harness/harness", () => ({ getHarnessReading: (...a: unknown[]) => getHarnessReading(...a), HARNESS_WORKSPACE: "public-harness" }));

import { GET, OPTIONS } from "@/app/api/harness/[id]/reading/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (origin = "https://ogiam.com") => new NextRequest("https://apex.test/api/harness/hs_1/reading", { headers: { origin } });

describe("GET /api/harness/[id]/reading (public)", () => {
  it("returns 200 with the reading for a known session", async () => {
    getHarnessReading.mockResolvedValueOnce({ ok: true, expired: false, reading: { sessionId: "hs_1", dossier: { threatLevel: "hostile" }, journey: {}, scaffolding: {} } });
    const res = await GET(req(), ctx("hs_1"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.reading.sessionId).toBe("hs_1");
    expect(j.expired).toBe(false);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://ogiam.com");
  });

  it("returns 404 for an unknown session (not a 500)", async () => {
    getHarnessReading.mockResolvedValueOnce({ ok: false, reason: "unknown" });
    const res = await GET(req(), ctx("nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_session");
  });

  it("answers the CORS preflight with 204", async () => {
    const res = await OPTIONS(req());
    expect(res.status).toBe(204);
  });
});

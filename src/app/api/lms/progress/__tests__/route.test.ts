/** @jest-environment node */
import { NextRequest } from "next/server";

const requireCapability = jest.fn();
const getCourseBySlug = jest.fn();
const setLessonProgress = jest.fn();
const getCourseProgress = jest.fn();
const trackEvent = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/lms/content", () => ({ getCourseBySlug: (...a: unknown[]) => getCourseBySlug(...a) }));
jest.mock("@/lib/lms/progress", () => ({
  setLessonProgress: (...a: unknown[]) => setLessonProgress(...a),
  getCourseProgress: (...a: unknown[]) => getCourseProgress(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { POST } from "@/app/api/lms/progress/route";

const OK = { ok: true, user: { id: "u1", role: "sales", workspaceId: "w1" } };
const COURSE = { id: "c1", slug: "security-plain-language", lessonIds: ["l1", "l2"] };
const req = (body: unknown) => new NextRequest("http://localhost/api/lms/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { [requireCapability, getCourseBySlug, setLessonProgress, getCourseProgress, trackEvent].forEach((m) => m.mockReset()); });

describe("POST /api/lms/progress", () => {
  it("401 when unauthenticated", async () => {
    requireCapability.mockResolvedValueOnce({ ok: false, response: new Response("", { status: 401 }) });
    expect((await POST(req({ slug: "security-plain-language", lessonId: "l1", action: "complete" }))).status).toBe(401);
  });

  it("records a completion and returns fresh progress", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getCourseBySlug.mockResolvedValueOnce(COURSE);
    setLessonProgress.mockResolvedValueOnce({ enrolled: true, lessons: { l1: "completed" }, completed: false });
    const res = await POST(req({ slug: "security-plain-language", lessonId: "l1", action: "complete" }));
    expect(res.status).toBe(200);
    expect((await res.json()).progress.lessons.l1).toBe("completed");
    expect(setLessonProgress).toHaveBeenCalledWith(expect.objectContaining({ courseId: "c1", lessonId: "l1", status: "completed", allLessonIds: ["l1", "l2"] }));
  });

  it("self_check fires an event without writing progress", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getCourseBySlug.mockResolvedValueOnce(COURSE);
    getCourseProgress.mockResolvedValueOnce({ enrolled: true, lessons: {}, completed: false });
    const res = await POST(req({ slug: "security-plain-language", lessonId: "l1", action: "self_check" }));
    expect(res.status).toBe(200);
    expect(trackEvent).toHaveBeenCalledWith("course.self_checked", "u1", "sales", expect.objectContaining({ lesson_id: "l1" }));
    expect(setLessonProgress).not.toHaveBeenCalled();
  });

  it("rejects a lesson that is not in the course (400, not a silent write)", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getCourseBySlug.mockResolvedValueOnce(COURSE);
    const res = await POST(req({ slug: "security-plain-language", lessonId: "l999", action: "complete" }));
    expect(res.status).toBe(400);
    expect(setLessonProgress).not.toHaveBeenCalled();
  });

  it("rejects an invalid action with 400", async () => {
    requireCapability.mockResolvedValue(OK);
    getCourseBySlug.mockResolvedValue(COURSE);
    expect((await POST(req({ slug: "security-plain-language", lessonId: "l1", action: "delete" }))).status).toBe(400);
  });
});

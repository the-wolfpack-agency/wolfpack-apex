/** @jest-environment node */
import { NextRequest } from "next/server";

const requireCapability = jest.fn();
const getCourseBySlug = jest.fn();
const getCourseProgress = jest.fn();
const seedSecurityCourse = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/lms/content", () => ({ getCourseBySlug: (...a: unknown[]) => getCourseBySlug(...a) }));
jest.mock("@/lib/lms/progress", () => ({ getCourseProgress: (...a: unknown[]) => getCourseProgress(...a) }));
jest.mock("@/lib/lms/seed-security-course", () => ({
  seedSecurityCourse: (...a: unknown[]) => seedSecurityCourse(...a),
  SECURITY_COURSE_SLUG: "security-plain-language",
}));

import { GET } from "@/app/api/lms/courses/[slug]/route";

const OK = { ok: true, user: { id: "u1", role: "sales", workspaceId: "w1" } };
const req = () => new NextRequest("http://localhost/api/lms/courses/security-plain-language");
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => { [requireCapability, getCourseBySlug, getCourseProgress, seedSecurityCourse].forEach((m) => m.mockReset()); });

describe("GET /api/lms/courses/[slug]", () => {
  it("401 when unauthenticated", async () => {
    requireCapability.mockResolvedValueOnce({ ok: false, response: new Response("unauthorized", { status: 401 }) });
    expect((await GET(req(), ctx("security-plain-language"))).status).toBe(401);
    expect(getCourseBySlug).not.toHaveBeenCalled();
  });

  it("seeds the security course, then returns course + the caller's progress", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getCourseBySlug.mockResolvedValueOnce({ id: "c1", slug: "security-plain-language", lessonIds: ["l1"] });
    getCourseProgress.mockResolvedValueOnce({ enrolled: true, lessons: { l1: "viewed" }, completed: false });
    const res = await GET(req(), ctx("security-plain-language"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course.id).toBe("c1");
    expect(body.progress.lessons.l1).toBe("viewed");
    expect(seedSecurityCourse).toHaveBeenCalledWith("w1");
    expect(requireCapability).toHaveBeenCalledWith(expect.anything(), "course.view");
    expect(getCourseProgress).toHaveBeenCalledWith("w1", "c1", "u1");
  });

  it("does NOT seed for an arbitrary slug, and 404s an unknown course", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getCourseBySlug.mockResolvedValueOnce(null);
    const res = await GET(req(), ctx("some-other-course"));
    expect(res.status).toBe(404);
    expect(seedSecurityCourse).not.toHaveBeenCalled();
  });
});

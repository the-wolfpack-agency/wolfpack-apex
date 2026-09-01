/**
 * The OCR policy, which exists so the expensive route cannot become the default.
 *
 * Sixty-two scanned PDFs and forty-three images are a third of everything the
 * Brain cannot answer. OCR is the first thing in this product that spends
 * money per DOCUMENT rather than per question, and a vision model costs one to
 * two orders of magnitude more per page than a purpose-built OCR API.
 *
 * The model router already learned this the expensive way: with both Azure
 * models configured it served 0% from the cheap tier for months, because its
 * only caller asked for `large` unconditionally. These tests are the version
 * of that lesson that fails the build instead of showing up on a cost page.
 */

import {
  decideOcrRoute,
  withinOcrBudget,
  VISION_API_CENTS_PER_PAGE,
  VISION_MODEL_CENTS_PER_PAGE,
  type OcrCapabilities,
} from "@/lib/brain/ocr-policy";

const BOTH: OcrCapabilities = { visionApi: true, visionModel: true };
const ONLY_MODEL: OcrCapabilities = { visionApi: false, visionModel: true };
const ONLY_API: OcrCapabilities = { visionApi: true, visionModel: false };
const NEITHER: OcrCapabilities = { visionApi: false, visionModel: false };

describe("the cheap route is the default", () => {
  it.each(["pdf", "image"] as const)("%s goes to the OCR API when both are available", (kind) => {
    const d = decideOcrRoute({ kind }, BOTH);
    expect(d.route).toBe("vision_api");
    expect(d.estimatedCentsPerPage).toBe(VISION_API_CENTS_PER_PAGE);
  });

  it("NEVER escalates to the model on a first attempt", () => {
    /* THE ONE THAT MATTERS. A page nobody has asked the OCR API about is not a
       page the OCR API failed on. Treating them the same is exactly how the
       router came to serve 0% from its cheap tier. */
    const d = decideOcrRoute({ kind: "pdf", failureDetail: "handwriting detected" }, BOTH);
    expect(d.route).toBe("vision_api");
  });

  it("the model is at least an order of magnitude dearer, which is the whole policy", () => {
    expect(VISION_MODEL_CENTS_PER_PAGE / VISION_API_CENTS_PER_PAGE).toBeGreaterThanOrEqual(10);
  });

  it("does not send tenant content out when the cheap route is used", () => {
    expect(decideOcrRoute({ kind: "pdf" }, BOTH).leavesTenant).toBe(false);
  });
});

describe("escalation is earned, not assumed", () => {
  it("escalates when the OCR API said it could not read the page", () => {
    const d = decideOcrRoute(
      { kind: "pdf", alreadyTried: "vision_api", failureDetail: "handwriting, low confidence" },
      BOTH,
    );
    expect(d.route).toBe("vision_model");
    expect(d.leavesTenant).toBe(true);
  });

  it("refuses to escalate a failure a model cannot fix", () => {
    /* A page too large, or corrupt, fails the same way on a model. Paying
       thirty times more to be told so twice is what an escalation rule that
       never says no costs. */
    const d = decideOcrRoute(
      { kind: "pdf", alreadyTried: "vision_api", failureDetail: "image 30MB exceeds Vision cap" },
      BOTH,
    );
    expect(d.route).toBe("none");
    expect(d.reason).toMatch(/a model cannot fix/);
  });

  it("says so plainly when there is nothing to escalate to", () => {
    const d = decideOcrRoute(
      { kind: "pdf", alreadyTried: "vision_api", failureDetail: "handwriting" },
      ONLY_API,
    );
    expect(d.route).toBe("none");
    expect(d.reason).toMatch(/no vision model is configured/);
  });
});

describe("when only the expensive route exists", () => {
  it("uses it, but names the cheaper alternative rather than choosing silently", () => {
    const d = decideOcrRoute({ kind: "image" }, ONLY_MODEL);
    expect(d.route).toBe("vision_model");
    /* An operator reading a surprising bill should find the fix in the reason,
       not have to go looking for it. */
    expect(d.reason).toMatch(/configuring Vision would cut this cost/);
  });

  it("refuses when nothing is configured, rather than pretending", () => {
    expect(decideOcrRoute({ kind: "pdf" }, NEITHER).route).toBe("none");
  });
});

describe("formats OCR cannot help", () => {
  it.each(["docx", "xlsx", "text", "csv", "html"] as const)("%s is never sent to OCR", (kind) => {
    /* A .docx with no text is a broken parse, not a scan. Sending it to a
       vision model would spend money to confirm a bug. */
    const d = decideOcrRoute({ kind }, BOTH);
    expect(d.route).toBe("none");
    expect(d.estimatedCentsPerPage).toBeNull();
  });
});

describe("the run is costed before it is authorized", () => {
  const api = decideOcrRoute({ kind: "pdf" }, BOTH);

  it("allows a run that fits, and says what it will cost", () => {
    const v = withinOcrBudget({ pages: 100, decision: api, ceilingCents: 50 });
    expect(v.allowed).toBe(true);
    expect(v.estimatedCents).toBe(10);
  });

  it("refuses a run that does not fit, and names both numbers", () => {
    /* "Over budget" alone leaves somebody guessing whether to raise the
       ceiling or split the batch. */
    const model = decideOcrRoute({ kind: "pdf", alreadyTried: "vision_api", failureDetail: "handwriting" }, BOTH);
    const v = withinOcrBudget({ pages: 1000, decision: model, ceilingCents: 50 });
    expect(v.allowed).toBe(false);
    expect(v.estimatedCents).toBe(3000);
    expect(v.reason).toContain("3000c");
    expect(v.reason).toContain("50c");
  });

  it("returns a null cost, never zero, when nothing will run", () => {
    /* Zero would read as "free", which is the opposite of "we are not doing
       it", and this repo has spent a week on that exact confusion. */
    const none = decideOcrRoute({ kind: "docx" }, BOTH);
    const v = withinOcrBudget({ pages: 10, decision: none, ceilingCents: 50 });
    expect(v.allowed).toBe(false);
    expect(v.estimatedCents).toBeNull();
  });

  it("refuses an empty batch instead of authorizing a zero-page run", () => {
    expect(withinOcrBudget({ pages: 0, decision: api, ceilingCents: 50 }).allowed).toBe(false);
  });

  it("never uses an em dash in a reason an operator will read", () => {
    const reasons = [
      decideOcrRoute({ kind: "pdf" }, BOTH).reason,
      decideOcrRoute({ kind: "image" }, ONLY_MODEL).reason,
      decideOcrRoute({ kind: "docx" }, BOTH).reason,
      withinOcrBudget({ pages: 1000, decision: api, ceilingCents: 1 }).reason,
    ];
    for (const r of reasons) expect(r).not.toContain("—");
  });
});

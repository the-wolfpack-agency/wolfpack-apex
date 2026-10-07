/**
 * The combined posture + its export artifact. The property that matters most is
 * the same one the whole compliance effort turns on: a category no scan covered is
 * "not assessed", never a pass - in both the data and the rendered document.
 */
import { assembleOwaspPosture, renderOwaspPostureMarkdown, CODE_ASSESSED_OWASP } from "../owasp-posture";

const status = (r: ReturnType<typeof assembleOwaspPosture>, id: string) =>
  r.assessments.find((a) => a.owasp.id === id)!.status;

describe("assembleOwaspPosture (combined code + live)", () => {
  it("a code scan makes the code categories assessed; a clean one reads checked_clear", () => {
    const r = assembleOwaspPosture({ codeFindings: [] }); // code scan ran, found nothing
    expect(status(r, "A03:2021")).toBe("checked_clear");
    expect(status(r, "A01:2021")).toBe("checked_clear");
    // A category NO scanner covers (A06 Vulnerable Components) stays not_assessed
    expect(status(r, "A06:2021")).toBe("not_assessed");
  });

  it("a code finding is a gap in its category", () => {
    const r = assembleOwaspPosture({ codeFindings: [{ title: "SQL injection: value interpolated into a query string", category: "security" }] });
    expect(status(r, "A03:2021")).toBe("gap");
  });

  it("live headers missing is an A05 gap; absent code scan leaves code categories not_assessed", () => {
    const r = assembleOwaspPosture({ liveHeadersAssessed: true, liveHeadersMissing: true });
    expect(status(r, "A05:2021")).toBe("gap");
    expect(status(r, "A03:2021")).toBe("not_assessed");
  });

  it("combined: code scan + live headers present -> both halves assessed", () => {
    const r = assembleOwaspPosture({ codeFindings: [], liveHeadersAssessed: true, liveHeadersMissing: false });
    expect(status(r, "A05:2021")).toBe("checked_clear");
    expect(status(r, "A03:2021")).toBe("checked_clear");
  });

  it("Forcefield active marks a code injection gap as compensated (code gap still counted)", () => {
    const r = assembleOwaspPosture({ codeFindings: [{ title: "XSS risk: dangerouslySetInnerHTML", category: "security" }], forcefieldActive: true });
    expect(status(r, "A03:2021")).toBe("compensated");
  });

  it("nothing scanned -> every category not_assessed (never a silent pass)", () => {
    const r = assembleOwaspPosture({});
    expect(r.assessments.every((a) => a.status === "not_assessed")).toBe(true);
  });

  it("CODE_ASSESSED_OWASP excludes the live-only A05-via-headers key but includes injection/access", () => {
    expect(CODE_ASSESSED_OWASP).toContain("A03:2021");
    expect(CODE_ASSESSED_OWASP).toContain("A01:2021");
  });
});

describe("renderOwaspPostureMarkdown (export artifact)", () => {
  it("renders a table and leads with the honesty note", () => {
    const md = renderOwaspPostureMarkdown(assembleOwaspPosture({ codeFindings: [{ title: "SQL injection", category: "security" }] }));
    expect(md).toMatch(/# Application security posture/);
    expect(md).toMatch(/Not assessed.*did not check/i);
    expect(md).toMatch(/\| A03:2021 Injection \| GAP \| CWE-89/);
  });

  it("is deterministic (no embedded timestamp) so a given scan reproduces byte-for-byte", () => {
    const input = { codeFindings: [{ title: "SSRF to cloud metadata", category: "security" }] };
    expect(renderOwaspPostureMarkdown(assembleOwaspPosture(input))).toBe(renderOwaspPostureMarkdown(assembleOwaspPosture(input)));
  });
});

import { renderQrSvg } from "@/lib/qr/svg";

describe("renderQrSvg", () => {
  test("produces an SVG string with a header and modules", () => {
    const svg = renderQrSvg("https://wolfpack-instinct.vercel.app/q/abc1234");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    /* Many <rect> modules. */
    const rectMatches = svg.match(/<rect /g) ?? [];
    expect(rectMatches.length).toBeGreaterThan(50);
  });

  test("respects size opt", () => {
    const svg = renderQrSvg("hello", { size: 320 });
    expect(svg).toContain('width="320"');
    expect(svg).toContain('height="320"');
    expect(svg).toContain('viewBox="0 0 320 320"');
  });

  test("respects dark / light colors", () => {
    const svg = renderQrSvg("hello", { dark: "#123456", light: "#abcdef" });
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('fill="#abcdef"');
  });

  test("works for short and longer URLs", () => {
    expect(() => renderQrSvg("a")).not.toThrow();
    expect(() =>
      renderQrSvg(
        "https://wolfpack-instinct.vercel.app/q/abc1234?with=some&params=for-realizm",
      ),
    ).not.toThrow();
  });

  test("rejects empty input", () => {
    expect(() => renderQrSvg("")).toThrow();
  });

  test("output is deterministic for same input (no random masking surprises)", () => {
    const a = renderQrSvg("https://x.test/q/abc1234");
    const b = renderQrSvg("https://x.test/q/abc1234");
    expect(a).toBe(b);
  });
});

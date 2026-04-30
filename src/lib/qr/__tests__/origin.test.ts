import { resolvePublicOrigin } from "@/lib/qr/origin";

const ORIG_NEXT_BASE = process.env.NEXT_PUBLIC_BASE_URL;
const ORIG_VERCEL = process.env.VERCEL_URL;

afterEach(() => {
  if (ORIG_NEXT_BASE === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = ORIG_NEXT_BASE;
  if (ORIG_VERCEL === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = ORIG_VERCEL;
});

function fakeReq(url: string): Request {
  return new Request(url);
}

describe("resolvePublicOrigin", () => {
  test("uses NEXT_PUBLIC_BASE_URL when set", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com";
    expect(resolvePublicOrigin(fakeReq("https://other.com/api/qr"))).toBe(
      "https://example.com",
    );
  });

  test("strips trailing slashes from NEXT_PUBLIC_BASE_URL", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.com/";
    expect(resolvePublicOrigin(fakeReq("https://other.com/x"))).toBe(
      "https://example.com",
    );
  });

  test("falls back to VERCEL_URL with https scheme prepended", () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    process.env.VERCEL_URL = "wolfpack-instinct.vercel.app";
    expect(resolvePublicOrigin(fakeReq("https://other.com/x"))).toBe(
      "https://wolfpack-instinct.vercel.app",
    );
  });

  test("falls back to request origin when no env is set", () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.VERCEL_URL;
    expect(
      resolvePublicOrigin(fakeReq("https://wolfpack-instinct.vercel.app/api/qr")),
    ).toBe("https://wolfpack-instinct.vercel.app");
  });

  test("NEVER returns a relative path (regression: phone cameras Google-search relative QR payloads)", () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.VERCEL_URL;
    const out = resolvePublicOrigin(
      fakeReq("https://wolfpack-instinct.vercel.app/api/qr"),
    );
    expect(out.startsWith("http")).toBe(true);
  });
});

/** @jest-environment node */
/** Site labels map to the hostname a reader recognizes, from existing config. */
import { siteHost } from "../site-host";

describe("siteHost", () => {
  const ORIG = process.env.INSTINCT_PUBLIC_URL;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.INSTINCT_PUBLIC_URL;
    else process.env.INSTINCT_PUBLIC_URL = ORIG;
  });

  it("instinct is the Instinct public host (the production alias by default)", () => {
    delete process.env.INSTINCT_PUBLIC_URL;
    expect(siteHost("instinct")).toBe("wolfpack-instinct.vercel.app");
  });

  it("follows INSTINCT_PUBLIC_URL when it is set", () => {
    process.env.INSTINCT_PUBLIC_URL = "https://instinct.example.test/";
    expect(siteHost("instinct")).toBe("instinct.example.test");
  });

  it("maps shim labels to the product catalog host", () => {
    expect(siteHost("weekendwithporsche")).toBe("weekendwithporsche.com");
    expect(siteHost("aidanmulready")).toBe("aidanmulready.com");
    expect(siteHost("ogiam")).toBe("ogiam.com");
  });

  it("a label that already is a hostname is kept (lowercased)", () => {
    expect(siteHost("ogiam.com")).toBe("ogiam.com");
    expect(siteHost("Client-Site.Example")).toBe("client-site.example");
  });

  it("falls back to the label when no host is known; empty stays empty", () => {
    expect(siteHost("unknown-label")).toBe("unknown-label");
    expect(siteHost("")).toBe("");
    expect(siteHost(undefined)).toBe("");
  });
});

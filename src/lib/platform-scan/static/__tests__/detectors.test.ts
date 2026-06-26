/**
 * Per-detector battery: each bug class is asserted to FIRE on a buggy sample
 * (severity/category + the exact evidence line) and to STAY SILENT on a clean
 * sample (the guard / wrapper / non-component case). runDetectors composition
 * is covered by the multi-class file at the end.
 */
import {
  silentFetch,
  rawAuthedFetchInClient,
  hardcodedTenantId,
  runDetectors,
} from "@/lib/platform-scan/static/detectors";

describe("silentFetch", () => {
  it("fires when a fetch body is parsed without an ok/status check", () => {
    const content = [
      "async function load() {",
      "  const res = await fetch(`/api/leads`);",
      "  const data = await res.json();",
      "  return data;",
      "}",
    ].join("\n");
    const f = silentFetch({ path: "app/page.tsx", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "high",
      category: "bug",
      title: "fetch result used without an ok/status check",
      route: "app/page.tsx",
    });
    expect(f[0].evidence.line).toBe(2);
    expect(f[0].evidence.snippet).toBe("const res = await fetch(`/api/leads`);");
  });

  it("does NOT fire when an if (!res.ok) throw guard is present in the window", () => {
    const content = [
      "async function load() {",
      "  const res = await fetch(`/api/leads`);",
      "  if (!res.ok) throw new Error('bad');",
      "  const data = await res.json();",
      "  return data;",
      "}",
    ].join("\n");
    expect(silentFetch({ path: "app/page.tsx", content })).toHaveLength(0);
  });

  it("does NOT fire when there is no body consumption near the fetch", () => {
    const content = [
      "function ping() {",
      "  fetch(`/api/health`);",
      "}",
    ].join("\n");
    expect(silentFetch({ path: "app/page.tsx", content })).toHaveLength(0);
  });
});

describe("rawAuthedFetchInClient", () => {
  it("fires on a raw /api fetch in a use client file", () => {
    const content = [
      '"use client";',
      "export function Widget() {",
      '  const p = fetch("/api/widgets");',
      "  return p;",
      "}",
    ].join("\n");
    const f = rawAuthedFetchInClient({ path: "components/widget.tsx", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "medium",
      category: "security",
      title:
        "raw fetch to /api from a client component (no token refresh; 401 blanks the page)",
    });
    expect(f[0].evidence.line).toBe(3);
  });

  it("does NOT fire when fetchWithRefresh is used", () => {
    const content = [
      '"use client";',
      "export function Widget() {",
      '  return fetchWithRefresh("/api/widgets");',
      "}",
    ].join("\n");
    expect(rawAuthedFetchInClient({ path: "components/widget.tsx", content })).toHaveLength(0);
  });

  it("does NOT fire in a server file (no use client directive)", () => {
    const content = [
      "export async function GET() {",
      '  return fetch("/api/widgets");',
      "}",
    ].join("\n");
    expect(rawAuthedFetchInClient({ path: "app/api/route.ts", content })).toHaveLength(0);
  });
});

describe("hardcodedTenantId", () => {
  it("fires on process.env.DEALER_ID in a page component", () => {
    const content = [
      "export default function Page() {",
      "  const dealer = process.env.DEALER_ID;",
      "  return dealer;",
      "}",
    ].join("\n");
    const f = hardcodedTenantId({ path: "app/dashboard/page.tsx", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "medium",
      category: "security",
      title: "hardcoded tenant id (process.env.DEALER_ID) in a page/component",
    });
    expect(f[0].evidence.line).toBe(2);
  });

  it("does NOT fire in a non-component file path", () => {
    const content = "const dealer = process.env.DEALER_ID;";
    expect(hardcodedTenantId({ path: "scripts/seed.ts", content })).toHaveLength(0);
  });

  it("does NOT fire when DEALER_ID is absent", () => {
    const content = "const x = process.env.OTHER;";
    expect(hardcodedTenantId({ path: "app/page.tsx", content })).toHaveLength(0);
  });
});

describe("runDetectors", () => {
  it("composes all detectors over one file", () => {
    const content = [
      '"use client";',
      "export default function Page() {",
      "  const dealer = process.env.DEALER_ID;",
      '  const res = fetch("/api/leads");',
      "  return res.json();",
      "}",
    ].join("\n");
    const f = runDetectors({ path: "app/page.tsx", content });
    const titles = f.map((x) => x.title).sort();
    expect(titles).toContain("fetch result used without an ok/status check");
    expect(titles).toContain(
      "raw fetch to /api from a client component (no token refresh; 401 blanks the page)",
    );
    expect(titles).toContain(
      "hardcoded tenant id (process.env.DEALER_ID) in a page/component",
    );
    expect(f.every((x) => x.route === "app/page.tsx")).toBe(true);
  });

  it("returns no findings on a clean file", () => {
    const content = [
      "export async function GET() {",
      "  const res = await fetch(`https://example.com`);",
      "  if (!res.ok) throw new Error('bad');",
      "  return res.json();",
      "}",
    ].join("\n");
    expect(runDetectors({ path: "app/api/route.ts", content })).toHaveLength(0);
  });
});

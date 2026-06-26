/**
 * Per-detector battery: each bug class is asserted to FIRE on a buggy sample
 * (severity/category + the exact evidence line) and to STAY SILENT on a clean
 * sample (the guard / wrapper / non-component case). runDetectors composition
 * is covered by the multi-class file at the end.
 */
import {
  silentFetch,
  hardcodedTenantId,
  emptyCatch,
  unvalidatedNumericInput,
  dangerousInnerHtml,
  suppressedTypecheck,
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

// rawAuthedFetchInClient was REMOVED (apex-specific convention, redundant with
// silentFetch, ~all false positives on a generic client platform). No tests.

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

describe("emptyCatch", () => {
  it("fires (low) on a multi-line empty catch around an ASYNC op", () => {
    const content = [
      "async function load() {",
      "  try {",
      "    await fetch('/api/x');",
      "  } catch (e) {",
      "  }",
      "}",
    ].join("\n");
    const f = emptyCatch({ path: "app/page.tsx", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "low",
      category: "bug",
      title: "error silently swallowed (empty catch)",
      route: "app/page.tsx",
    });
    expect(f[0].evidence.line).toBe(4);
  });

  it("fires on a same-line empty catch around an await", () => {
    const content = [
      "async function load() {",
      "  try { await fetch('/api/x'); } catch {}",
      "}",
    ].join("\n");
    expect(emptyCatch({ path: "app/page.tsx", content })).toHaveLength(1);
  });

  it("does NOT fire on an empty catch with NO async op (low-signal noise)", () => {
    const content = [
      "function parse(s) {",
      "  try { return JSON.parse(s); } catch {}",
      "}",
    ].join("\n");
    expect(emptyCatch({ path: "app/page.tsx", content })).toHaveLength(0);
  });

  it("does NOT fire on the `catch {} finally {}` cleanup idiom", () => {
    const content = [
      "async function load() {",
      "  try { await fetch('/api/x'); } catch {} finally { setLoading(false); }",
      "}",
    ].join("\n");
    expect(emptyCatch({ path: "app/page.tsx", content })).toHaveLength(0);
  });

  it("does NOT fire when the catch body has a statement", () => {
    const content = [
      "async function load() {",
      "  try {",
      "    await fetch('/api/x');",
      "  } catch (e) {",
      "    setError(e);",
      "  }",
      "}",
    ].join("\n");
    expect(emptyCatch({ path: "app/page.tsx", content })).toHaveLength(0);
  });
});

describe("unvalidatedNumericInput", () => {
  it("fires on a number input with no min attribute", () => {
    const content = [
      "export function PriceField() {",
      '  return <input type="number" name="price" value={price} />;',
      "}",
    ].join("\n");
    const f = unvalidatedNumericInput({ path: "components/price.tsx", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "medium",
      category: "ux_gap",
      title: "numeric input without a min/range guard (accepts invalid values)",
      route: "components/price.tsx",
    });
    expect(f[0].evidence.line).toBe(2);
  });

  it("does NOT fire when min= is present on the input", () => {
    const content = [
      "export function PriceField() {",
      '  return <input type="number" name="price" min={0} value={price} />;',
      "}",
    ].join("\n");
    expect(
      unvalidatedNumericInput({ path: "components/price.tsx", content }),
    ).toHaveLength(0);
  });

  it("does NOT fire on a text input", () => {
    const content = '  return <input type="text" name="title" />;';
    expect(
      unvalidatedNumericInput({ path: "components/title.tsx", content }),
    ).toHaveLength(0);
  });
});

describe("dangerousInnerHtml", () => {
  it("fires on a dangerouslySetInnerHTML usage", () => {
    const content = [
      "export function Body({ html }) {",
      "  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
      "}",
    ].join("\n");
    const f = dangerousInnerHtml({ path: "components/body.tsx", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "high",
      category: "security",
      title: "XSS risk: dangerouslySetInnerHTML",
      route: "components/body.tsx",
    });
    expect(f[0].evidence.line).toBe(2);
  });

  it("does NOT fire on the safe JSON-LD JSON.stringify pattern", () => {
    const content = [
      "export function Ld({ data }) {",
      '  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;',
      "}",
    ].join("\n");
    expect(dangerousInnerHtml({ path: "components/ld.tsx", content })).toHaveLength(0);
  });

  it("does NOT fire on a line a reviewer marked audit-safe", () => {
    const content = [
      "export function Body({ html }) {",
      "  // audit-safe: html is a hardcoded literal",
      "  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
      "}",
    ].join("\n");
    expect(dangerousInnerHtml({ path: "components/body.tsx", content })).toHaveLength(0);
  });

  it("does NOT fire on a plain div with sanitized text", () => {
    const content = [
      "export function Body({ text }) {",
      "  return <div>{text}</div>;",
      "}",
    ].join("\n");
    expect(
      dangerousInnerHtml({ path: "components/body.tsx", content }),
    ).toHaveLength(0);
  });
});

describe("suppressedTypecheck", () => {
  it("fires on a @ts-ignore line", () => {
    const content = [
      "function f() {",
      "  // @ts-ignore the lib types are wrong",
      "  return lib.thing();",
      "}",
    ].join("\n");
    const f = suppressedTypecheck({ path: "lib/f.ts", content });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      severity: "medium",
      category: "bug",
      title: "type safety suppressed (@ts-ignore / @ts-nocheck)",
      route: "lib/f.ts",
    });
    expect(f[0].evidence.line).toBe(2);
  });

  it("fires on a @ts-nocheck line", () => {
    const content = ["// @ts-nocheck", "export const x = 1;"].join("\n");
    const f = suppressedTypecheck({ path: "lib/f.ts", content });
    expect(f).toHaveLength(1);
    expect(f[0].evidence.line).toBe(1);
  });

  it("does NOT fire on @ts-expect-error", () => {
    const content = [
      "function f() {",
      "  // @ts-expect-error intentional, checked by the compiler",
      "  return lib.thing();",
      "}",
    ].join("\n");
    expect(suppressedTypecheck({ path: "lib/f.ts", content })).toHaveLength(0);
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

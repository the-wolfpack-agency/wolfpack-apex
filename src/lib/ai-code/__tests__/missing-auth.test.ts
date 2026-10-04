/**
 * Missing-authorization gate (CWE-862): the factory HOLDS a protected API route it
 * authored with no auth control, mirroring the repo's capability-coverage net, but
 * never false-fires on a gated / public / non-route file.
 */
import { findMissingAuth, isProtectedApiRoute, hasAuthControl } from "@/lib/ai-code/missing-auth";

const route = (path: string, content: string) => ({ path, content });

describe("isProtectedApiRoute", () => {
  it("matches a protected module route.ts (various path shapes)", () => {
    expect(isProtectedApiRoute("src/app/api/admin/foo/route.ts")).toBe(true);
    expect(isProtectedApiRoute("app/api/clients/route.ts")).toBe(true);
    expect(isProtectedApiRoute("b/src/app/api/finance/x/y/route.ts")).toBe(true);
  });
  it("does NOT match a non-protected module, a page, or a non-route file", () => {
    expect(isProtectedApiRoute("src/app/api/public/route.ts")).toBe(false); // not in the protected set
    expect(isProtectedApiRoute("src/app/(dashboard)/admin/page.tsx")).toBe(false);
    expect(isProtectedApiRoute("src/lib/admin/thing.ts")).toBe(false);
  });
});

describe("hasAuthControl", () => {
  it("recognizes the auth entrypoints + the public marker", () => {
    expect(hasAuthControl("const a = await requireCapability(req, 'x');")).toBe(true);
    expect(hasAuthControl("const g = await requireEntitlement(ws, 'secure_agent');")).toBe(true);
    expect(hasAuthControl("const a = factoryServiceAuth(req);")).toBe(true);
    expect(hasAuthControl("// PUBLIC: health check, no auth by design")).toBe(true);
  });
  it("is false when nothing gates", () => {
    expect(hasAuthControl("export async function POST(req){ return Response.json({ok:true}); }")).toBe(false);
  });
});

describe("findMissingAuth", () => {
  it("HOLDS a protected route with no auth control (critical, CWE-862)", () => {
    const f = findMissingAuth([route("src/app/api/admin/widgets/route.ts", "export async function POST(req){ return Response.json({ created: true }); }")]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", category: "security", route: "src/app/api/admin/widgets/route.ts" });
    expect(f[0].title).toMatch(/CWE-862/);
  });
  it("passes a route that gates with requireCapability", () => {
    expect(findMissingAuth([route("src/app/api/admin/widgets/route.ts", "const a = await requireCapability(req,'settings.manage_team'); export async function POST(){}")])).toEqual([]);
  });
  it("passes a route explicitly marked // PUBLIC", () => {
    expect(findMissingAuth([route("src/app/api/docs/ping/route.ts", "// PUBLIC health check\nexport async function GET(){ return Response.json({ok:true}); }")])).toEqual([]);
  });
  it("ignores non-protected routes and non-route files (no false positives)", () => {
    expect(findMissingAuth([
      route("src/app/api/webhooks/stripe/route.ts", "export async function POST(){}"), // not a protected module
      route("src/lib/util.ts", "export const x = 1;"),
      route("src/app/(dashboard)/admin/page.tsx", "export default function P(){ return null; }"),
    ])).toEqual([]);
  });
});

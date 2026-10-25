/**
 * Missing-authorization gate (CWE-862): the factory HOLDS a protected API route it
 * authored with no auth control, mirroring the repo's capability-coverage net, but
 * never false-fires on a gated / public / non-route file.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findMissingAuth, isProtectedApiRoute, hasAuthControl, PROTECTED_API_MODULES } from "@/lib/ai-code/missing-auth";

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

// ---------------------------------------------------------------------------
// Fixtures drawn from THIS repo's own route shapes (read from disk, not
// paraphrased), so the rule is proven against the code it will actually gate.
// ---------------------------------------------------------------------------

function walkRoutes(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRoutes(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const ROOT = process.cwd();
const real = (rel: string) => ({ path: rel, content: readFileSync(join(ROOT, rel), "utf8") });

describe("true negatives: every protected route already in this repo", () => {
  const files = PROTECTED_API_MODULES.flatMap((m) => walkRoutes(join(ROOT, "src/app/api", m))).map((abs) =>
    real(abs.slice(ROOT.length + 1)),
  );

  it("finds the protected routes (the walk is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("produces ZERO findings over the repo's real protected routes", () => {
    expect(findMissingAuth(files).map((f) => f.route)).toEqual([]);
  });

  it("recognizes each real auth shape: requireCapability, getUserFromRequest, verifyToken<T>()", () => {
    expect(hasAuthControl(real("src/app/api/admin/platform-scans/profile/route.ts").content)).toBe(true);
    expect(hasAuthControl(real("src/app/api/admin/audit-log/route.ts").content)).toBe(true);
    expect(hasAuthControl(real("src/app/api/tasks/route.ts").content)).toBe(true);
    expect(hasAuthControl(real("src/app/api/admin/connectors/oauth/[provider]/callback/route.ts").content)).toBe(true);
  });
});

describe("true positives: the same real routes with their auth call removed", () => {
  const strip = (rel: string, call: RegExp) => {
    const r = real(rel);
    const content = r.content.replace(call, "null as never; //");
    expect(content).not.toBe(r.content); // the fixture really removed something
    return { path: rel, content };
  };

  it("the admin profile route without requireCapability is held", () => {
    const f = strip("src/app/api/admin/platform-scans/profile/route.ts", /await requireCapability\([^)]*\)/g);
    expect(findMissingAuth([f])).toHaveLength(1);
  });

  it("the audit-log route without getUserFromRequest is held", () => {
    const f = strip("src/app/api/admin/audit-log/route.ts", /getUserFromRequest\([^)]*\)\)/g);
    // the import line still names it, but not as a call
    expect(findMissingAuth([f])).toHaveLength(1);
  });

  it("the tasks route without getUserFromRequest is held", () => {
    const f = strip("src/app/api/tasks/route.ts", /getUserFromRequest\([^)]*\)\)/g);
    expect(findMissingAuth([f])).toHaveLength(1);
  });
});

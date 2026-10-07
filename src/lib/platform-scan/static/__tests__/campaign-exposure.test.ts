/**
 * Campaign-exposure detectors: the static "codebase guardian" layer that finds the
 * code constructs enabling the multi-step agentic attacks Forcefield catches at
 * runtime. Tested where the risk is: the hole is flagged, and a properly-scoped or
 * auth-gated route is NOT (a false positive on a safe route is the costly outcome).
 */
import { missingAuthzSensitiveRoute, idorObjectAccess } from "../detectors";

const file = (path: string, content: string) => ({ path, content });

describe("missingAuthzSensitiveRoute (CWE-862, recon->access reachability)", () => {
  it("flags a sensitive data route with no authorization signal", () => {
    const f = file("src/app/api/admin/users/route.ts", [
      "export async function GET() {",
      "  const users = await prisma.user.findMany();",
      "  return Response.json(users);",
      "}",
    ].join("\n"));
    const out = missingAuthzSensitiveRoute(f);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("medium");
    expect(out[0].category).toBe("security");
  });

  it("does NOT flag the same route when it checks authorization", () => {
    const f = file("src/app/api/admin/users/route.ts", [
      "export async function GET(req) {",
      "  const session = await getServerSession();",
      "  if (!session) return new Response('no', { status: 401 });",
      "  const users = await prisma.user.findMany();",
      "  return Response.json(users);",
      "}",
    ].join("\n"));
    expect(missingAuthzSensitiveRoute(f)).toEqual([]);
  });

  it("does NOT flag a non-sensitive route", () => {
    const f = file("src/app/api/blog/route.ts", "export async function GET() { return Response.json(await prisma.post.findMany()); }");
    expect(missingAuthzSensitiveRoute(f)).toEqual([]);
  });

  it("does NOT flag a sensitive PAGE that is not a data route", () => {
    const f = file("src/components/AdminBanner.tsx", "export function AdminBanner() { return <div>admin</div>; }");
    expect(missingAuthzSensitiveRoute(f)).toEqual([]);
  });
});

describe("idorObjectAccess (CWE-639 / BOLA, id-enumeration shape)", () => {
  it("flags a by-id lookup with no ownership scope", () => {
    const f = file("src/app/api/invoices/[id]/route.ts", [
      "export async function GET(req, { params }) {",
      "  const invoice = await prisma.invoice.findUnique({ where: { id: params.id } });",
      "  return Response.json(invoice);",
      "}",
    ].join("\n"));
    const out = idorObjectAccess(f);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].title).toMatch(/IDOR/);
  });

  it("does NOT flag when the query is scoped to the authenticated user", () => {
    const f = file("src/app/api/invoices/[id]/route.ts", [
      "export async function GET(req, { params }) {",
      "  const invoice = await prisma.invoice.findFirst({ where: { id: params.id, userId: req.user.id } });",
      "  return Response.json(invoice);",
      "}",
    ].join("\n"));
    expect(idorObjectAccess(f)).toEqual([]);
  });

  it("does NOT flag a route that reads an id but does not look up by it", () => {
    const f = file("src/app/api/ping/route.ts", "export async function GET(req) { const id = req.query.id; return Response.json({ echoed: id }); }");
    expect(idorObjectAccess(f)).toEqual([]);
  });

  it("does NOT flag a non-route file even if it looks up by id", () => {
    const f = file("src/lib/data/invoices.ts", "export const get = (id) => prisma.invoice.findUnique({ where: { id } });");
    expect(idorObjectAccess(f)).toEqual([]);
  });

  // Precision regressions: the three safe routes dogfooding flagged. Scoping can be
  // a domain ownership column, user.id/user.role params, or an upstream scoping call.
  it("does NOT flag a query scoped by a domain ownership column + user.id/role params", () => {
    const f = file("src/app/api/reports/[id]/route.ts", [
      "const { id } = await params;",
      "const { rows } = await safeQuery(",
      "  `SELECT id, title FROM instinct_documents WHERE id = $1 AND (generated_by = $2 OR $3 IN ('cto','ceo'))`,",
      "  [id, user.id, user.role],",
      ");",
    ].join("\n"));
    expect(idorObjectAccess(f)).toEqual([]);
  });
  it("does NOT flag when ownership was enforced upstream (getCachedTaskById(user.id, id))", () => {
    const f = file("src/app/api/tasks/[id]/complete/route.ts", [
      "const user = getUserFromRequest(req.headers.get('authorization'));",
      "const { id } = await params;",
      "const existing = await getCachedTaskById(user.id, id);",
      "if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });",
      "const { rows } = await safeQuery(`SELECT ms_list_id FROM instinct_task_lists WHERE id = $1 LIMIT 1`, [existing.listId]);",
    ].join("\n"));
    expect(idorObjectAccess(f)).toEqual([]);
  });
});

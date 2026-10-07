/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/docs. Auth (401/403); list without a doc;
 * one doc rendered to HTML; unknown doc -> 404. The registry/renderer are mocked
 * so the contract needs no filesystem.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockList = jest.fn();
const mockByKey = jest.fn();
const mockRead = jest.fn();
const mockRender = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/forcefield-web/gtm-docs", () => ({
  listGtmDocs: () => mockList(),
  gtmDocByKey: (...a: unknown[]) => mockByKey(...a),
  readGtmDoc: (...a: unknown[]) => mockRead(...a),
}));
jest.mock("@/lib/markdown", () => ({ renderMarkdown: (...a: unknown[]) => mockRender(...a) }));

import { GET } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const LIST = [{ key: "pricing", title: "Pricing", category: "Commercial", file: "pricing-and-packaging.md" }];
const url = (q = "") => new NextRequest(`http://x/api/admin/forcefield/docs${q}`);

beforeEach(() => { jest.clearAllMocks(); mockList.mockReturnValue(LIST); });

it("401/403 when the capability check denies", async () => {
  mockRequireCapability.mockResolvedValueOnce(deny(401));
  expect((await GET(url())).status).toBe(401);
  mockRequireCapability.mockResolvedValueOnce(deny(403));
  expect((await GET(url())).status).toBe(403);
});

it("lists the docs (no body) when no ?doc is given", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  const res = await GET(url());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.docs).toEqual(LIST);
  expect(body.html).toBeUndefined();
});

it("renders one doc to HTML when ?doc is a known key", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockByKey.mockReturnValueOnce(LIST[0]);
  mockRead.mockReturnValueOnce("# Pricing\n\nflat per site");
  mockRender.mockReturnValueOnce("<h1>Pricing</h1>");
  const res = await GET(url("?doc=pricing"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.doc.key).toBe("pricing");
  expect(body.html).toBe("<h1>Pricing</h1>");
  expect(mockRender).toHaveBeenCalledWith("# Pricing\n\nflat per site");
});

it("404 for an unknown doc key", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockByKey.mockReturnValueOnce(undefined);
  expect((await GET(url("?doc=bogus"))).status).toBe(404);
});

it("404 when the file cannot be read", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockByKey.mockReturnValueOnce(LIST[0]);
  mockRead.mockReturnValueOnce(null);
  expect((await GET(url("?doc=pricing"))).status).toBe(404);
});

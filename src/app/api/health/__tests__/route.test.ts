/** @jest-environment node */
export {};
import { GET } from "../route";
const probe = { ok: true };
jest.mock("@/lib/db", () => ({ query: jest.fn(async () => { if (!probe.ok) throw new Error("timeout exceeded when trying to connect"); return { rows: [{ "?column?": 1 }] }; }) }));
const req = (u: string) => new Request(u);
beforeEach(() => { probe.ok = true; });

it("liveness: plain GET is 200 with no DB probe", async () => {
  const res = await GET(req("http://x/api/health"));
  expect(res.status).toBe(200);
  expect((await res.json()).db).toBeUndefined();
});
it("readiness: ?deep=1 is 200 db:up when the DB answers", async () => {
  const res = await GET(req("http://x/api/health?deep=1"));
  expect(res.status).toBe(200);
  expect((await res.json()).db).toBe("up");
});
it("readiness: ?deep=1 is 503 db:down when the DB is unreachable", async () => {
  probe.ok = false;
  const res = await GET(req("http://x/api/health?deep=1"));
  expect(res.status).toBe(503);
  expect((await res.json())).toMatchObject({ ok: false, db: "down" });
});

/** Contract for the datacenter-ranges refresh cron: CRON_SECRET gate + never-throw 200. */
import { GET } from "../route";
const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });
it("rejects an unauthorized call when CRON_SECRET is set", async () => {
  process.env.CRON_SECRET = "s3cret";
  const res = await GET(new Request("http://x/api/cron/datacenter-ranges-refresh"));
  expect(res.status).toBe(401);
});
it("runs and returns 200 when authorized (degrades cleanly with no DB)", async () => {
  process.env.CRON_SECRET = "s3cret"; delete process.env.DATABASE_URL;
  const res = await GET(new Request("http://x/api/cron/datacenter-ranges-refresh", { headers: { authorization: "Bearer s3cret" } }));
  expect(res.status).toBe(200);
  expect((await res.json())).toHaveProperty("prefixes");
});

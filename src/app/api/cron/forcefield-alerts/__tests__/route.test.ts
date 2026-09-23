/** Contract for the forcefield-alerts cron: CRON_SECRET gate + never-throw 200. */
import { GET } from "../route";
const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

it("rejects an unauthorized call when CRON_SECRET is set", async () => {
  process.env.CRON_SECRET = "s3cret";
  const res = await GET(new Request("http://x/api/cron/forcefield-alerts"));
  expect(res.status).toBe(401);
});

it("runs and returns 200 when authorized", async () => {
  process.env.CRON_SECRET = "s3cret";
  const res = await GET(new Request("http://x/api/cron/forcefield-alerts", { headers: { authorization: "Bearer s3cret" } }));
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});

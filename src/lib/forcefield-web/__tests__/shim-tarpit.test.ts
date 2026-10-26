/** @jest-environment node */
import { forcefieldDecide, SHIM_MAX_TARPIT_MS } from "@/lib/forcefield-web/shim";

const cfg = { endpoint: "https://engine.example/api/forcefield/observe", token: "t", site: "s", stack: ["nextjs"] };
const signals = { path: "/bitrix/a", rawUrl: "/bitrix/a", method: "GET", userAgent: "curl/8", country: "US", headerNames: ["user-agent"] };

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test("a tarpit answer slows the request (bounded) and lets it through", async () => {
  jest.useFakeTimers();
  const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ action: "tarpit", delayMs: 60_000 })));
  let done = false;
  const p = forcefieldDecide(signals, cfg).then((b) => { done = true; return b; });
  await jest.advanceTimersByTimeAsync(SHIM_MAX_TARPIT_MS - 10);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(20);
  expect(await p).toBe(false);
  expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)).stack).toEqual(["nextjs"]);
});

test("an authenticated request is never slowed or blocked", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ action: "tarpit", delayMs: 3000 })));
  const t = Date.now();
  expect(await forcefieldDecide({ ...signals, authenticated: true }, cfg)).toBe(false);
  expect(Date.now() - t).toBeLessThan(1000);
});

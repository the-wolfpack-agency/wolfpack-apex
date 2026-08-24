/**
 * Proof that fakeFetch behaves like fetch.
 *
 * WHY THIS FILE EXISTS
 *
 * Almost every bug that reached CI or production in this area had one shape: a
 * test double encoded my BELIEF about an external contract, the code was
 * written against the same belief, and the tests then confirmed the bug. The
 * suite was not neutral — it actively vouched for the mistake.
 *
 *   headers modelled as a property, when Playwright exposes headers() (#222)
 *   ok computed as status < 400, when fetch sets it for 2xx only      (#224)
 *   an already-aborted signal ignored, when fetch rejects immediately (#224)
 *
 * Reviewing a fake by reading it cannot catch this, because the reviewer and
 * the author are checking it against the same wrong mental model. The only
 * thing that settles it is running the real implementation and the double
 * through identical scenarios and asserting they agree.
 *
 * So that is what this does. A real HTTP server on loopback, real fetch and
 * fakeFetch driven through the same table, asserting on the same properties.
 * No network, no fixtures anyone has to keep in sync: if Node's fetch changes,
 * this fails and tells us, which is precisely the signal we lacked.
 *
 * The bar for adding a case here: any property of fetch that production code
 * relies on. If code depends on it, the double must be proven to match on it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fakeFetch, htmlResponse, redirectTo, type FakeResponseSpec } from "./fake-fetch";

/* NO TEST MAY RESOLVE DNS.
 *
 * The SSRF guard calls dns.lookup on every URL it clears, including each
 * hop of a redirect, and its own comment notes that the lookup is not
 * covered by the scan's abort signal. These suites use example.com and
 * example.org, which resolve for real, so every redirect test was making
 * a live DNS query.
 *
 * It is invisible on a laptop with a warm resolver and it is a hang on a
 * CI runner. On 2026-08-23 "reports a redirect target as the URL actually
 * scanned" exceeded jest's five-second limit and failed a build on a
 * branch that had touched none of this.
 *
 * The lookup is stubbed rather than the guard: the guard's logic still
 * runs, still rejects private addresses, and simply gets its answer from
 * here instead of from the network. A public address keeps every existing
 * expectation true.
 */
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));


let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/redirect") {
      res.writeHead(302, { location: "/landing", "X-Mixed-Case": "yes" });
      return res.end();
    }
    if (url === "/created") {
      res.writeHead(201, { "Content-Type": "text/plain" });
      return res.end("made");
    }
    if (url === "/no-content") {
      res.writeHead(204);
      return res.end();
    }
    if (url === "/missing") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("nope");
    }
    if (url === "/boom") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("bang");
    }
    if (url === "/hang") {
      return; // never responds; the caller's abort has to end it
    }
    res.writeHead(200, { "Content-Type": "text/html", "X-Mixed-Case": "yes" });
    res.end("<html>hi</html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Each case: a live path, and the spec that should imitate it. */
const CASES: { name: string; path: string; spec: FakeResponseSpec }[] = [
  { name: "200", path: "/", spec: htmlResponse("<html>hi</html>", { "Content-Type": "text/html", "X-Mixed-Case": "yes" }) },
  { name: "201", path: "/created", spec: { status: 201, headers: { "Content-Type": "text/plain" }, body: "made" } },
  { name: "204", path: "/no-content", spec: { status: 204, body: "" } },
  { name: "302", path: "/redirect", spec: redirectTo("/landing") },
  { name: "404", path: "/missing", spec: { status: 404, headers: { "Content-Type": "text/plain" }, body: "nope" } },
  { name: "500", path: "/boom", spec: { status: 500, headers: { "Content-Type": "text/plain" }, body: "bang" } },
];

describe("fakeFetch agrees with real fetch", () => {
  it.each(CASES)("$name: ok and status match", async ({ path, spec }) => {
    // `ok` is the property that has burned us: real fetch sets it for 2xx and
    // NOTHING else, so a 302 is not ok.
    const real = await fetch(`${base}${path}`, { redirect: "manual" });
    const fake = await fakeFetch(spec)(`${base}${path}`, { redirect: "manual" });
    expect({ ok: fake.ok, status: fake.status }).toEqual({ ok: real.ok, status: real.status });
  });

  it.each(CASES)("$name: body matches", async ({ path, spec }) => {
    const real = await fetch(`${base}${path}`, { redirect: "manual" });
    const fake = await fakeFetch(spec)(`${base}${path}`, { redirect: "manual" });
    expect(await fake.text()).toBe(await real.text());
  });

  it("a 3xx is NOT ok, in both", async () => {
    // Stated on its own because it is the exact mistake, and an it.each row is
    // easy to skim past.
    const real = await fetch(`${base}/redirect`, { redirect: "manual" });
    const fake = await fakeFetch(redirectTo("/landing"))(`${base}/redirect`, { redirect: "manual" });
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
  });

  it("header lookup is case-insensitive in both", async () => {
    const real = await fetch(`${base}/`);
    const fake = await fakeFetch(htmlResponse("x", { "X-Mixed-Case": "yes" }))(`${base}/`);
    expect(real.headers.get("x-mixed-case")).toBe("yes");
    expect(fake.headers.get("x-mixed-case")).toBe("yes");
    expect(fake.headers.get("X-MIXED-CASE")).toBe("yes");
  });

  it("redirect: manual returns the 3xx itself rather than following it, in both", async () => {
    // Verified against the real implementation rather than assumed: Node returns
    // the actual 302 with its Location readable, not an opaque redirect.
    const real = await fetch(`${base}/redirect`, { redirect: "manual" });
    const fake = await fakeFetch(redirectTo("/landing"))(`${base}/redirect`, { redirect: "manual" });
    expect(real.status).toBe(302);
    expect(real.headers.get("location")).toBe("/landing");
    expect(fake.status).toBe(302);
    expect(fake.headers.get("location")).toBe("/landing");
  });

  it("rejects immediately on an ALREADY-aborted signal, in both", async () => {
    // The one that hung CI. A signal that has already fired will never emit an
    // abort event, so a double that only registers a listener waits forever
    // while real fetch has already rejected.
    const controller = new AbortController();
    controller.abort();

    const realErr = await fetch(`${base}/`, { signal: controller.signal }).catch((e: Error) => e);
    const fakeErr = await fakeFetch(htmlResponse("x"))(`${base}/`, { signal: controller.signal }).catch((e: Error) => e);

    expect((realErr as Error).name).toBe("AbortError");
    expect((fakeErr as Error).name).toBe("AbortError");
  });

  it("rejects when aborted mid-flight, in both", async () => {
    const realController = new AbortController();
    setTimeout(() => realController.abort(), 20);
    const realErr = await fetch(`${base}/hang`, { signal: realController.signal }).catch((e: Error) => e);

    const fakeController = new AbortController();
    setTimeout(() => fakeController.abort(), 20);
    const fakeErr = await fakeFetch([], { hang: true })(`${base}/hang`, { signal: fakeController.signal }).catch(
      (e: Error) => e,
    );

    expect((realErr as Error).name).toBe("AbortError");
    expect((fakeErr as Error).name).toBe("AbortError");
  });

  it("reports the requested URL, in both", async () => {
    const real = await fetch(`${base}/`);
    const fake = await fakeFetch(htmlResponse("x"))(`${base}/`);
    expect(fake.url).toBe(real.url);
  });
});

describe("the proof is real", () => {
  it("would FAIL if the fake computed ok the way the broken ones did", async () => {
    // A contract test nobody has watched fail is a contract test nobody knows
    // works. This reproduces the exact defect and shows the comparison catches
    // it, so the file above is evidence rather than decoration.
    const broken = { ok: 302 < 400, status: 302 };
    const real = await fetch(`${base}/redirect`, { redirect: "manual" });
    expect(broken.ok).not.toBe(real.ok);
  });
});

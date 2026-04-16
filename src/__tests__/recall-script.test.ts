/**
 * Tests for scripts/recall.sh.
 *
 * Spins up a tiny localhost HTTP server that mimics Qdrant's REST API
 * (the collection GET + points/scroll POST) and points the script at it
 * via QDRANT_URL. Asserts that results are printed and ranked.
 *
 * Also tests graceful failure when no backend is reachable.
 */
import { spawnSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "recall.sh");

/**
 * Start a fake Qdrant in a *separate* node process. Running the server
 * in-process with jest doesn't work: spawnSync blocks the event loop so
 * the server never accepts the subprocess's connection. A child process
 * sidesteps that entirely.
 */
function startFakeQdrant(): Promise<{ kill: () => void; url: string }> {
  return new Promise((resolveP, rejectP) => {
    const serverCode = `
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/collections/apex_knowledge')) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({result: {status: 'ok'}}));
    return;
  }
  if (req.method === 'POST' && req.url === '/collections/apex_knowledge/points/scroll') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      result: {
        points: [
          {id: 1, payload: {
            question: 'How do we gate an API route with capability?',
            answer: "Call requireCapability(req, 'module.action'); return gate.response if !gate.ok.",
            source: 'wolfpack-apex',
            repo: 'wolfpack-apex',
            tags: ['auth', 'capability'],
            indexed_at: '2026-04-15T00:00:00Z',
          }},
          {id: 2, payload: {
            question: 'What is the payroll override policy?',
            answer: 'Override requires CEO/CTO capability.',
            source: 'handbook',
            tags: ['hr', 'payroll'],
          }},
        ],
      },
    }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write('PORT=' + addr.port + '\\n');
});
process.on('SIGTERM', () => process.exit(0));
`;
    const child = spawn("node", ["-e", serverCode], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        child.stdout!.off("data", onData);
        resolveP({
          kill: () => child.kill("SIGTERM"),
          url: `http://127.0.0.1:${m[1]}`,
        });
      }
    };
    child.stdout!.on("data", onData);
    child.on("error", rejectP);
    setTimeout(() => rejectP(new Error("fake qdrant did not start in 5s")), 5000);
  });
}

function run(qdrantUrl: string | null, query: string, top?: number) {
  const args = [SCRIPT, query];
  if (top) args.push("--top", String(top));
  return spawnSync("bash", args, {
    env: {
      ...process.env,
      QDRANT_URL: qdrantUrl ?? "http://127.0.0.1:1",
      INSTINCT_URL: "",
    },
    encoding: "utf-8",
  });
}

describe("scripts/recall.sh", () => {
  let fakeQdrant: { kill: () => void; url: string } | null = null;
  let url = "";

  beforeAll(async () => {
    fakeQdrant = await startFakeQdrant();
    url = fakeQdrant.url;
  }, 10_000);

  afterAll(async () => {
    if (fakeQdrant) fakeQdrant.kill();
    // Small delay to let the subprocess terminate before jest tears down.
    await new Promise((r) => setTimeout(r, 50));
  });

  it("returns ranked matches when Qdrant has content matching the query", () => {
    const res = run(url, "gate API route capability");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/How do we gate an API route/);
    expect(res.stdout).toMatch(/score=/);
  });

  it("respects --top", () => {
    const res = run(url, "payroll", 1);
    expect(res.status).toBe(0);
    // payroll only hits row 2 → exactly one result.
    expect(res.stdout.match(/^#\d+ /gm)?.length).toBe(1);
  });

  it("prints 'no matches' when nothing in the collection hits", () => {
    const res = run(url, "xyzzy_no_match_anywhere_ever");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no matches/);
  });

  it("exits 1 with a helpful message when no backend is reachable", () => {
    const res = run("http://127.0.0.1:1", "anything");
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/no backend reachable/);
  });

  it("exits 2 when called with no query", () => {
    const res = spawnSync("bash", [SCRIPT], {
      env: { ...process.env, QDRANT_URL: url },
      encoding: "utf-8",
    });
    expect(res.status).toBe(2);
    expect(res.stderr + res.stdout).toMatch(/usage:/);
  });

  it("exits 2 when --top is non-numeric", () => {
    const res = spawnSync("bash", [SCRIPT, "q", "--top", "banana"], {
      env: { ...process.env, QDRANT_URL: url },
      encoding: "utf-8",
    });
    expect(res.status).toBe(2);
  });
});

/**
 * Run only the e2e specs that cover what this change touched.
 *
 * THE GAP THIS CLOSES. verify.sh reports nine green stages while printing
 * `[SKIP] e2e-smoke (local run - CI only)`. On 2026-08-26 a change to /playbook
 * passed verify that way and broke two hard gates in production. Nine green
 * stages does not mean the e2e specs ran.
 *
 * WHY NOT RUN THEM ALL. A verify that takes ten minutes is a verify people
 * stop running, and an unrun gate is worth nothing. So the cost is paid only
 * by changes that could plausibly break a covered page: no mapped file, no
 * cost beyond a `git diff`.
 *
 * WHY A LOCAL SERVER RATHER THAN PROD_URL. Running these specs against the
 * deployed URL tests the code that is ALREADY live, which is exactly the code
 * that is not being changed. The /playbook regression would have passed such a
 * check right up until it was deployed. The point is to run the spec against
 * the build sitting in this working tree.
 *
 * Reuses the `next build` output that verify.sh produced in the stage before,
 * so the marginal cost is starting a server plus the specs themselves.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";

const BASE_REF = process.env.VERIFY_BASE_REF || "origin/main";

function changedFiles(): string[] {
  const tryCmd = (args: string[]): string[] | null => {
    try {
      return execFileSync("git", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
      return null;
    }
  };
  /* Committed changes against the base, plus anything still uncommitted, so a
     dirty tree is checked rather than silently ignored. */
  const committed = tryCmd(["diff", "--name-only", `${BASE_REF}...HEAD`]) ?? [];
  const working = tryCmd(["diff", "--name-only", "HEAD"]) ?? [];
  const untracked = tryCmd(["ls-files", "--others", "--exclude-standard"]) ?? [];
  return [...new Set([...committed, ...working, ...untracked])];
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main(): Promise<number> {
  const { specsForChanges } = await import("../tests/e2e/change-map");
  const changed = changedFiles();
  const specs = specsForChanges(changed);

  if (specs.length === 0) {
    console.log(`[e2e-changed] no covered page touched (${changed.length} files changed). Nothing to run.`);
    return 0;
  }

  console.log(`[e2e-changed] ${specs.length} spec(s) cover this change:`);
  for (const s of specs) console.log(`  ${s}`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  console.log(`[e2e-changed] starting the built app on ${port}`);

  const server = spawn("npx", ["next", "start", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let serverLog = "";
  server.stdout?.on("data", (d: Buffer) => (serverLog += d));
  server.stderr?.on("data", (d: Buffer) => (serverLog += d));

  const stop = () => {
    try {
      server.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);

  try {
    if (!(await waitForReady(url, 90_000))) {
      console.error("[e2e-changed] the server never became ready. Run `npx next build` first.");
      console.error(serverLog.slice(-2000));
      return 1;
    }
    execFileSync(
      "npx",
      ["playwright", "test", ...specs, "--config=playwright.config.ts", "--reporter=list"],
      { stdio: "inherit", env: { ...process.env, PROD_URL: url } },
    );
    return 0;
  } catch {
    /* Playwright printed the failure; a second copy of it helps nobody. */
    return 1;
  } finally {
    stop();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[e2e-changed]", err?.message ?? err);
    process.exit(1);
  },
);

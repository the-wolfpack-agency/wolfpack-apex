/**
 * @jest-environment node
 *
 * The sandbox runs real subprocesses, so these tests actually spawn `node`. It
 * must: pass a green run, fail a non-zero exit, SIGKILL a runaway on timeout,
 * refuse a disallowed executable, and refuse a path that escapes the temp dir.
 */
import { runInSandbox } from "../sandbox";

describe("runInSandbox", () => {
  it("passes a script that exits 0 and captures stdout", async () => {
    const res = await runInSandbox({
      files: { "t.mjs": "console.log('hello'); process.exit(0);" },
      command: ["node", "t.mjs"],
    });
    expect(res.passed).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello");
    expect(res.error).toBeNull();
  });

  it("fails a script that exits non-zero (a failing test)", async () => {
    const res = await runInSandbox({
      files: { "t.mjs": "console.error('assertion failed'); process.exit(1);" },
      command: ["node", "t.mjs"],
    });
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("assertion failed");
  });

  it("kills a runaway on timeout (never hangs the oracle)", async () => {
    const res = await runInSandbox({
      files: { "t.mjs": "while(true){}" },
      command: ["node", "t.mjs"],
      timeoutMs: 500,
    });
    expect(res.passed).toBe(false);
    expect(res.timedOut).toBe(true);
  }, 10_000);

  it("refuses a disallowed executable", async () => {
    const res = await runInSandbox({ files: {}, command: ["bash", "-c", "echo pwned"] });
    expect(res.passed).toBe(false);
    expect(res.error).toMatch(/not allowed/);
  });

  it("refuses a file path that escapes the sandbox", async () => {
    const res = await runInSandbox({ files: { "../evil.mjs": "x" }, command: ["node", "-e", "0"] });
    expect(res.passed).toBe(false);
    expect(res.error).toMatch(/escapes the sandbox/);
  });

  it("runs a module + its test together (the capability oracle shape)", async () => {
    const res = await runInSandbox({
      files: {
        "add.mjs": "export const add = (a, b) => a + b;",
        "test.mjs": "import { add } from './add.mjs'; import assert from 'node:assert'; assert.equal(add(2,3),5); console.log('ok');",
      },
      command: ["node", "test.mjs"],
    });
    expect(res.passed).toBe(true);
    expect(res.stdout).toContain("ok");
  });
});

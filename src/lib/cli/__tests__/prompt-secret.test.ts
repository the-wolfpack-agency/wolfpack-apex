/**
 * A secret should not survive being asked for.
 *
 * `--password hunter2` lands in shell history and, on most systems, in `ps`
 * output where every other process can read it. It also has to be pasted
 * somewhere to get there, which in practice means a chat window.
 *
 * Driven through injected streams rather than a real terminal, so the key
 * handling that matters when typing blind is actually tested: Enter finishes,
 * Backspace deletes, and Ctrl-C still aborts.
 */

import { EventEmitter } from "node:events";
import { promptSecret, NoTerminalError } from "@/lib/cli/prompt-secret";

/**
 * A stdin that looks enough like a TTY to drive the prompt.
 *
 * Built as a plain object and cast once, rather than augmenting ReadStream:
 * Node types setRawMode, resume and pause as chainable, so an inline
 * augmentation ends up fighting signatures the fixture does not care about.
 */
function fakeTty() {
  const rawModeCalls: boolean[] = [];
  const emitter = new EventEmitter();
  const stream = Object.assign(emitter, {
    isTTY: true,
    rawModeCalls,
    setRawMode(v: boolean) {
      rawModeCalls.push(v);
      return stream;
    },
    resume: () => stream,
    pause: () => stream,
    setEncoding: () => stream,
  });
  return stream as typeof stream & NodeJS.ReadStream;
}

function fakeOut() {
  const written: string[] = [];
  return {
    written,
    stream: { write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream,
  };
}

describe("reading a secret from a terminal", () => {
  it("returns what was typed, and never echoes it", async () => {
    const input = fakeTty();
    const out = fakeOut();
    const p = promptSecret("Password: ", { input, output: out.stream });
    input.emit("data", "hunter2");
    input.emit("data", "\r");
    expect(await p).toBe("hunter2");
    /* The label and a newline. The secret itself must appear nowhere. */
    expect(out.written.join("")).not.toContain("hunter2");
  });

  it("handles backspace, because typing blind means typos", async () => {
    const input = fakeTty();
    const p = promptSecret("p", { input, output: fakeOut().stream });
    input.emit("data", "abcX");
    input.emit("data", "\u007f");
    input.emit("data", "d\n");
    expect(await p).toBe("abcd");
  });

  /* A prompt that swallowed Ctrl-C would be a worse thing to have built than
     no prompt at all. */
  it("still aborts on Ctrl-C", async () => {
    const input = fakeTty();
    const p = promptSecret("p", { input, output: fakeOut().stream });
    input.emit("data", "partial");
    input.emit("data", "\u0003");
    await expect(p).rejects.toThrow(/cancelled/);
  });

  /* An arrow key sends an escape sequence. Appending it would put three
     invisible bytes into a password nobody typed. */
  it("ignores control characters rather than storing them", async () => {
    const input = fakeTty();
    const p = promptSecret("p", { input, output: fakeOut().stream });
    input.emit("data", "ab\u001b[Acd\r");
    expect(await p).toBe("abcd");
  });

  it("always restores the terminal, however it ends", async () => {
    const input = fakeTty();
    const p = promptSecret("p", { input, output: fakeOut().stream });
    input.emit("data", "x\r");
    await p;
    expect(input.rawModeCalls).toEqual([true, false]);
  });
});

describe("when there is no terminal", () => {
  /* Automation cannot type, so an explicit env var wins. */
  it("prefers an env var, and does not touch the terminal", async () => {
    process.env.TEST_SECRET_VAR = "from-env";
    const input = fakeTty();
    expect(await promptSecret("p", { envVar: "TEST_SECRET_VAR", input })).toBe("from-env");
    expect(input.rawModeCalls).toEqual([]);
    delete process.env.TEST_SECRET_VAR;
  });

  it("names the env var to set when it cannot prompt", async () => {
    const notTty = new EventEmitter() as unknown as NodeJS.ReadStream;
    (notTty as unknown as { isTTY: boolean }).isTTY = false;
    await expect(promptSecret("p", { envVar: "MAP_PASSWORD", input: notTty })).rejects.toThrow(
      NoTerminalError,
    );
    await expect(promptSecret("p", { envVar: "MAP_PASSWORD", input: notTty })).rejects.toThrow(
      /MAP_PASSWORD/,
    );
  });
});

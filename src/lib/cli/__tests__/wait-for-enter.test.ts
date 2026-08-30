/**
 * Waiting for a person, because some sign-ins cannot be scripted.
 *
 * Cognito's login has no form element at all: four buttons of type="button"
 * offering Google, Facebook, Microsoft or email, and only after choosing does
 * an email field appear. Three attempts at selectors produced three different
 * failures, none of them about mapping.
 *
 * The person signs in once and the map starts from the session they made,
 * which works on every flow including the ones nobody has written a selector
 * for. It also means the password never enters the process, so there is
 * nothing to prompt for and nothing to scrub out of an error.
 */

import { EventEmitter } from "node:events";
import { waitForEnter, NoTerminalError } from "@/lib/cli/wait-for-enter";

function fakeTty() {
  const emitter = new EventEmitter();
  const stream = Object.assign(emitter, {
    isTTY: true,
    resume: () => stream,
    pause: () => stream,
    setEncoding: () => stream,
  });
  return stream as typeof stream & NodeJS.ReadStream;
}

function fakeOut() {
  const written: string[] = [];
  return { written, stream: { write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream };
}

describe("waiting for the person to be ready", () => {
  it("resolves on Enter", async () => {
    const input = fakeTty();
    const p = waitForEnter("ready? ", { input, output: fakeOut().stream });
    input.emit("data", "\r");
    await expect(p).resolves.toBeUndefined();
  });

  it("shows the prompt so somebody knows it is waiting", async () => {
    const input = fakeTty();
    const out = fakeOut();
    const p = waitForEnter("Press Enter when signed in: ", { input, output: out.stream });
    input.emit("data", "\n");
    await p;
    expect(out.written.join("")).toContain("Press Enter when signed in");
  });

  /* Somebody who cannot sign in needs a way out that is not killing the
     terminal. */
  it("aborts on Ctrl-C", async () => {
    const input = fakeTty();
    const p = waitForEnter("ready? ", { input, output: fakeOut().stream });
    input.emit("data", "\u0003");
    await expect(p).rejects.toThrow(/cancelled/);
  });

  /* It deliberately does not try to detect a successful login: a heuristic
     would guess wrong on exactly the flows this exists to support, and the
     person watching the browser already knows. */
  it("ignores other keys rather than guessing somebody is done", async () => {
    const input = fakeTty();
    let settled = false;
    const p = waitForEnter("ready? ", { input, output: fakeOut().stream }).then(() => {
      settled = true;
    });
    input.emit("data", "some typing");
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    input.emit("data", "\r");
    await p;
    expect(settled).toBe(true);
  });

  it("says so when there is no terminal to confirm on", async () => {
    const notTty = new EventEmitter() as unknown as NodeJS.ReadStream;
    (notTty as unknown as { isTTY: boolean }).isTTY = false;
    await expect(waitForEnter("ready? ", { input: notTty })).rejects.toThrow(NoTerminalError);
  });
});

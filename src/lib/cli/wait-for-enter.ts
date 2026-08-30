/**
 * Wait for a person to say they are ready.
 *
 * WHY A MAPPER NEEDS THIS. Automating a sign-in is a losing game. Cognito's
 * login has no form element at all: four buttons of type="button" offering
 * Google, Facebook, Microsoft or email, and only after choosing does an email
 * field appear, and only after that a password. Microsoft and Google are
 * multi-step too. Add MFA, SSO redirects and bot detection and the selector
 * guessing never ends: three attempts here produced three different failures,
 * none of them about mapping.
 *
 * A person signs in once, in a real browser, and the map starts from the
 * session they created. Every login flow works, including the ones nobody has
 * written a selector for yet.
 *
 * IT ALSO DELETES THE PROBLEM RATHER THAN GUARDING IT. The password never
 * enters this process, so there is nothing to prompt for, nothing to scrub out
 * of an error, and nothing to rotate when a library quotes what it was
 * filling. That happened here, and the strongest fix for handling a secret
 * carefully is not to hold one.
 */

export interface WaitOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class NoTerminalError extends Error {
  constructor() {
    super("Signing in by hand needs a terminal to confirm on.");
    this.name = "NoTerminalError";
  }
}

/**
 * Block until the person presses Enter, or abandons with Ctrl-C.
 *
 * Deliberately does not try to detect that a login succeeded. A heuristic
 * would guess wrong on exactly the flows this exists to support, and the
 * person watching the browser already knows.
 */
export async function waitForEnter(prompt: string, opts: WaitOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  if (!input.isTTY) throw new NoTerminalError();

  output.write(prompt);
  input.resume();
  input.setEncoding("utf8");

  return new Promise<void>((resolve, reject) => {
    const finish = (settle: () => void) => {
      input.removeListener("data", onData);
      input.pause();
      settle();
    };
    const onData = (chunk: string) => {
      /* Ctrl-C must abort here as everywhere: somebody who cannot sign in
         needs a way out that is not killing the terminal. */
      if (chunk.includes("\u0003")) {
        finish(() => reject(new Error("cancelled")));
        return;
      }
      if (chunk.includes("\r") || chunk.includes("\n")) {
        finish(() => resolve());
      }
    };
    input.on("data", onData);
  });
}

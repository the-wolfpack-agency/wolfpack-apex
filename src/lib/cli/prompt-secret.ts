/**
 * Ask for a secret without writing it anywhere.
 *
 * WHY NOT A COMMAND-LINE FLAG. `--password hunter2` is worse than it looks. It
 * lands in shell history, and on most systems process arguments are readable
 * by anyone who can run `ps`, so the secret is briefly visible to every other
 * process on the machine. It also has to be pasted somewhere to get there,
 * which in practice means a chat window.
 *
 * WHY AN ENV VAR IS BETTER BUT NOT BEST. Other scripts here already read
 * PROBE_PASSWORD from the environment, which is right: /proc/<pid>/environ is
 * readable only by the same user, unlike argv. It still persists in whatever
 * set it, usually a shell profile or a CI variable.
 *
 * A typed prompt persists nowhere. Not echoed, not stored, gone when the
 * process exits.
 *
 * ORDER: an explicit env var wins, because automation cannot type. Otherwise
 * prompt. There is deliberately no flag.
 */

/** Keys that matter when typing blind, named rather than left as bytes. */
const ENTER = "\r";
const NEWLINE = "\n";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";
const ESCAPE = "\u001b";

export interface PromptOptions {
  /** Checked first, so a CI run can supply it without a terminal. */
  envVar?: string;
  /** Streams injected so a test can drive this without a real terminal. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class NoTerminalError extends Error {
  constructor(envVar?: string) {
    super(
      envVar
        ? `No terminal to prompt on. Set ${envVar} instead, or run this from a terminal.`
        : "No terminal to prompt on.",
    );
    this.name = "NoTerminalError";
  }
}

/**
 * Read a secret from the environment, or from a terminal with echo off.
 *
 * Handles the three keys that matter when typing blind: Enter finishes,
 * Backspace deletes, and Ctrl-C still aborts. A prompt that swallowed Ctrl-C
 * would be a worse thing to have built than no prompt at all.
 */
export async function promptSecret(label: string, opts: PromptOptions = {}): Promise<string> {
  const fromEnv = opts.envVar ? process.env[opts.envVar] : undefined;
  if (fromEnv) return fromEnv;

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new NoTerminalError(opts.envVar);
  }

  output.write(label);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const finish = (settle: () => void) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      settle();
    };

    /* True while an escape sequence is being consumed. An arrow key arrives as
       ESC [ A, and dropping only the ESC leaves "[A" in the password: three
       bytes nobody typed, in a field nobody can see. Caught by a test rather
       than by reading the code. */
    let inEscape = false;

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (inEscape) {
          /* A CSI sequence ends on its final byte, which is a letter or one
             of a few symbols. Everything up to it is parameters. */
          if (/[A-Za-z~]/.test(ch)) inEscape = false;
          continue;
        }
        if (ch === ESCAPE) {
          inEscape = true;
          continue;
        }
        if (ch === ENTER || ch === NEWLINE || ch === CTRL_D) {
          finish(() => resolve(value));
          return;
        }
        if (ch === CTRL_C) {
          /* Must still abort. Nothing here is worth breaking this. */
          finish(() => reject(new Error("cancelled")));
          return;
        }
        if (ch === BACKSPACE || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        /* Other control characters are ignored rather than appended: an arrow
           key would otherwise add three invisible bytes nobody typed. */
        if (ch >= " ") value += ch;
      }
    };

    input.on("data", onData);
  });
}

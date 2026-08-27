/**
 * A plain Enter in the assistant composer sends nothing. Keep it out of the specs.
 *
 * WHAT HAPPENED. Seven e2e specs filled the assistant composer and pressed
 * Enter, and not one of them ever submitted a message. The composer is a
 * textarea whose `handleKeyDown` submits on Cmd/Ctrl+Enter only, which is
 * correct behaviour for a multi-line prompt box: a plain Enter inserts a
 * newline. So every one of those specs typed a sentence, sent nothing, and
 * then waited for a response that was never requested.
 *
 * This is the same failure the routing audit and the never-executed reviewer
 * both were: code written against the shape the author assumed rather than the
 * shape the product produces, with a passing or quietly timing-out test on top
 * of it. The class is fixed (all seven specs now drive the send button through
 * `helpers/assistant-composer`), and this is the check that stops it returning.
 *
 * Deliberately a repo scan rather than a lint rule: the mistake is a correct
 * Playwright call on the wrong element, which no linter can see.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const E2E_DIR = join(process.cwd(), "tests", "e2e");

/**
 * A spec is suspect when it touches the assistant composer AND presses a bare
 * Enter anywhere in the same file. Scoped to composer-touching specs so an
 * Enter press on a search box or a login form, where Enter genuinely does
 * submit, is not flagged.
 */
const COMPOSER_MARKERS = [
  "assistant-composer-input",
  "assistant-send-btn",
  "submitComposer",
  "askAssistant",
];

/* Cmd/Ctrl+Enter is the real submit shortcut and stays allowed. */
const BARE_ENTER = /\.press\(\s*["'`]Enter["'`]\s*\)/;

function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => join(E2E_DIR, f));
}

describe("assistant composer submit path", () => {
  it("no spec that drives the composer submits with a bare Enter", () => {
    const offenders: string[] = [];
    for (const file of specFiles()) {
      const src = readFileSync(file, "utf8");
      if (!COMPOSER_MARKERS.some((m) => src.includes(m))) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (BARE_ENTER.test(line)) {
          offenders.push(`${file.replace(process.cwd() + "/", "")}:${i + 1} ${line.trim()}`);
        }
      });
    }
    /* Named, not counted. A guard that says "3 offenders" sends somebody
       hunting; one that names the file and line is actionable. */
    expect(offenders).toEqual([]);
  });

  it("the composer specs actually go through the shared helper", () => {
    /* Proves the guard above is not passing because nothing drives the
       composer any more. An empty scan is indistinguishable from a clean one
       otherwise, which is the exact bug this whole session is about. */
    const usingHelper = specFiles().filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("submitComposer") || src.includes("askAssistant");
    });
    expect(usingHelper.length).toBeGreaterThanOrEqual(7);
  });

  it("the helper drives the send button rather than a key press", () => {
    const helper = readFileSync(
      join(E2E_DIR, "helpers", "assistant-composer.ts"),
      "utf8",
    );
    expect(helper).toContain("assistant-send-btn");
    expect(helper).not.toMatch(BARE_ENTER);
  });

  it("the composer still only submits on Cmd/Ctrl+Enter, which is why the rule exists", () => {
    /* If the product ever starts submitting on a bare Enter, this guard has
       outlived its reason and should be deleted rather than kept passing. The
       assertion documents the dependency instead of leaving it in a comment. */
    const chat = readFileSync(
      join(process.cwd(), "src", "components", "InstinctChat.tsx"),
      "utf8",
    );
    const handler = chat.slice(chat.indexOf("function handleKeyDown"));
    const body = handler.slice(0, handler.indexOf("\n  }"));
    expect(body).toMatch(/metaKey|ctrlKey/);
    expect(body).toMatch(/e\.key === "Enter"/);
  });
});

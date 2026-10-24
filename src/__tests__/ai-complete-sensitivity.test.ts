/**
 * Enforces: every AI completion request built in product code declares its
 * `sensitivity`.
 *
 * The router decides who may answer a request from its sensitivity: a request
 * carrying personal, health or confidential data may only go to a provider that
 * qualifies as zero-retention (src/lib/ai/retention.ts). A request with no
 * sensitivity skips that check entirely. In October 2026 the assistant
 * (`assistant_chat`, which reads mail, calendar and CRM) and the external
 * gate (`/api/gate/complete`) set none, so the busiest personal-data paths
 * were invisible to the gate even in observe mode.
 *
 * What is checked: each `.complete({ ... })` call whose argument is an object
 * literal with `messages:` (an AICompleteRequest). It must contain
 * `sensitivity`, or spread an existing request (`...req`), which carries the
 * caller's value. A call that passes a variable (`client.complete(r)`) is an
 * adapter: the literal it forwards is built, and checked, where it is written
 * (for example src/lib/ai-code/author.ts).
 *
 * Exceptions go in ALLOWLIST with a reason. A stale entry fails too, so the
 * list cannot quietly outlive the code it excuses.
 *
 * Which value: "pii" for anything that can carry client or personal data.
 * Not "confidential" unless the content is source code: confidential skips the
 * credential redaction pass (redaction.ts redactMessages).
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

/** "file::feature" for a call that may omit sensitivity, and why. */
const ALLOWLIST: Record<string, string> = {
  "src/lib/agent-probe-runner.ts::agent_probe":
    "Reads public HTTP responses from operator-allowlisted probe targets and returns one path; no client or personal data.",
  "src/lib/ai/a2a-proof.ts::feature":
    "Operator demo CLI: the prompt is authored by the operator and the provider is pinned on purpose to prove cross-family handoff.",
  "src/lib/ai/a2a-proof.ts::`${feature}-judge`":
    "Judge of the operator demo above; same data, internal_check.",
};

const SKIP_DIRS = ["__tests__", "node_modules", ".next"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export interface CompleteCall {
  file: string;
  line: number;
  feature: string;
  arg: string;
}

/** Every `.complete(` call in `source` with its full argument text. */
export function findCompleteCalls(file: string, source: string): CompleteCall[] {
  const calls: CompleteCall[] = [];
  const re = /\.complete\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    const arg = source.slice(start, i - 1);
    const named = arg.match(/feature:\s*(`[^`]*`|"[^"]*"|'[^']*'|[\w.$]+)/)?.[1];
    const shorthand = /[{,]\s*feature\s*[,}]/.test(arg) ? "feature" : "";
    const feature = (named ?? shorthand).replace(/^["']|["']$/g, "");
    calls.push({ file, line: source.slice(0, m.index).split("\n").length, feature, arg });
  }
  return calls;
}

/** An AICompleteRequest literal (not a GateAgent `{ prompt }` or an adapter). */
export function isRequestLiteral(arg: string): boolean {
  return arg.trimStart().startsWith("{") && /\bmessages\b\s*[:,}]/.test(arg);
}

export function declaresSensitivity(arg: string): boolean {
  return /\bsensitivity\b/.test(arg) || /^\{\s*\.\.\.\w+/.test(arg.trim());
}

describe("every AI completion request declares its sensitivity", () => {
  const files = walk(path.join(ROOT, "src"));
  const calls = files.flatMap((f) =>
    findCompleteCalls(path.relative(ROOT, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")),
  );
  const requests = calls.filter((c) => isRequestLiteral(c.arg));

  it("finds the call sites (the scan itself works)", () => {
    expect(requests.length).toBeGreaterThan(15);
    expect(requests.some((c) => c.feature === "assistant_chat")).toBe(true);
    expect(requests.some((c) => c.feature === "gate.external_agent")).toBe(true);
  });

  it("no request literal omits sensitivity outside the allowlist", () => {
    const missing = requests
      .filter((c) => !declaresSensitivity(c.arg))
      .filter((c) => !ALLOWLIST[`${c.file}::${c.feature}`])
      .map((c) => `${c.file}:${c.line} (feature ${c.feature || "?"})`);
    expect(missing).toEqual([]);
  });

  it("assistant_chat and the external gate are tagged", () => {
    for (const feature of ["assistant_chat", "gate.external_agent"]) {
      const site = requests.find((c) => c.feature === feature);
      expect(site && declaresSensitivity(site.arg)).toBe(true);
    }
  });

  it("every allowlist entry still matches an untagged call (no stale exceptions)", () => {
    const untagged = new Set(
      requests.filter((c) => !declaresSensitivity(c.arg)).map((c) => `${c.file}::${c.feature}`),
    );
    const stale = Object.keys(ALLOWLIST).filter((k) => !untagged.has(k));
    expect(stale).toEqual([]);
  });

  it("every allowlist entry has a reason", () => {
    for (const reason of Object.values(ALLOWLIST)) expect(reason.length).toBeGreaterThan(20);
  });
});

describe("the scanner", () => {
  it("flags an untagged request literal and accepts a tagged or spread one", () => {
    const src = [
      `a.complete({ messages: [], metadata: { feature: "x" } });`,
      `a.complete({ messages: [], sensitivity: "pii", metadata: { feature: "y" } });`,
      `a.complete({ ...req, model_tier: "cheap" });`,
      `a.complete(r);`,
      `agent.complete({ prompt, feature: "g" });`,
    ].join("\n");
    const calls = findCompleteCalls("f.ts", src);
    expect(calls).toHaveLength(5);
    expect(calls.map((c) => isRequestLiteral(c.arg))).toEqual([true, true, false, false, false]);
    expect(declaresSensitivity(calls[0].arg)).toBe(false);
    expect(declaresSensitivity(calls[1].arg)).toBe(true);
    expect(calls[0].feature).toBe("x");
  });
});

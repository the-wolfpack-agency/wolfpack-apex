/**
 * Guard: a route never answers 401 for a PROVIDER-connection reason, and an
 * action never answers 200 { connected: false } (see the second describe).
 *
 * 401 means only "your Instinct session is invalid". fetchWithRefresh
 * (src/lib/client-auth.ts) treats every 401 as an expired session: it rotates
 * the refresh token, retries, and on a refresh failure sends a signed-in person
 * to /login. When /api/emails/inbox answered 401 for "Microsoft not connected",
 * every visit to /emails by a user without a Microsoft connection cost two 401s
 * and a refresh-token rotation, and could bounce them to /login.
 *
 * Not connected is 200 { connected: false } for a read and 409 for an action,
 * built by providerNotConnected() in src/lib/integrations/not-connected.ts.
 * Connected but missing a scope stays 403 scope_missing.
 *
 * How it decides: for every place that emits a 401 (`status: 401`, a `? 401 :`
 * status map, or the forms executor's `failure("auth", ...)`), it reads the
 * statement that leads to it (the emission line plus its `if` / `case` header)
 * and fails when that statement names a provider-connection reason:
 * not connected / not_connected, or a Graph error's `err.status === 401`.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

const EMISSION = /status:\s*401\b|\?\s*401\s*:|failure\(\s*["']auth["']/;
const PROVIDER_REASON =
  /not[_\s-]?connected|notConnected|\b(?:err|e|error)\.status\s*===\s*401|\.code\s*===\s*["']not_connected["']/i;
const HEADER = /^\s*(?:if\b|case\b|\}\s*else\b|else\b|default\s*:)/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

export interface Provider401Finding {
  file: string;
  line: number;
  text: string;
}

/** The statement that produces the emission at `idx`: the emission line plus
 *  the lines above it back to (and including) its `if` / `case` header,
 *  stopping at the end of the previous statement. */
function statementFor(lines: string[], idx: number): string {
  const out = [lines[idx]];
  for (let i = idx - 1; i >= 0 && i >= idx - 6; i--) {
    const l = lines[i];
    if (COMMENT.test(l)) continue;
    const t = l.trim();
    if (t === "" || /[;}]$/.test(t) || t.endsWith("*/")) break;
    out.unshift(l);
    if (HEADER.test(l)) break;
  }
  return out.join("\n");
}

export function findProvider401s(file: string, source: string): Provider401Finding[] {
  const lines = source.split("\n");
  const findings: Provider401Finding[] = [];
  lines.forEach((l, i) => {
    if (COMMENT.test(l) || !EMISSION.test(l)) return;
    if (PROVIDER_REASON.test(statementFor(lines, i))) {
      findings.push({ file, line: i + 1, text: l.trim() });
    }
  });
  return findings;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Route handlers, plus any lib module that builds HTTP responses. */
function responseBuildingFiles(): string[] {
  const routes = walk(path.join(ROOT, "src/app/api")).filter((f) => f.endsWith("route.ts"));
  const libs = walk(path.join(ROOT, "src/lib")).filter((f) => {
    const s = fs.readFileSync(f, "utf8");
    return /from\s+["']next\/server["']/.test(s) && /NextResponse/.test(s);
  });
  return [...routes, ...libs];
}

describe("no route answers 401 for a provider-connection reason", () => {
  it("scans every route handler and response-building lib module", () => {
    const files = responseBuildingFiles();
    // Sanity: the walk found the surface it is meant to guard.
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((f) =>
      findProvider401s(path.relative(ROOT, f), fs.readFileSync(f, "utf8")),
    );
    expect(
      findings.map((x) => `${x.file}:${x.line}  ${x.text}`),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Second half of the rule: an ACTION never answers 200 { connected: false }.  */
/* A 200 to a send / create / update that did not happen reads as success to  */
/* every consumer that checks res.ok (the Teams composer kept the message in   */
/* the thread as sent). Actions answer 409 via providerNotConnected().         */
/* ------------------------------------------------------------------------- */

const HANDLER = /^export\s+(?:async\s+function\s+|const\s+)(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/;
const ACTION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const NOT_CONNECTED_BODY = /(?<![\w$])connected:\s*false\b|notConnectedBody\(/;
const ACTION_STATUS = /status:\s*(?:409|NOT_CONNECTED_ACTION_STATUS)\b/;

/** A POST that is a read in all but verb (the payload is too large for a
 *  query string). Its "not connected" answer is a read's: 200 and empty. */
export const READ_VIA_POST: Record<string, string> = {
  "src/app/api/ms/presence/route.ts POST":
    "batch presence lookup; POST only to carry the user id list",
};

export interface ActionNotConnected200Finding {
  file: string;
  method: string;
  line: number;
  text: string;
}

export function findActionNotConnected200s(
  file: string,
  source: string,
): ActionNotConnected200Finding[] {
  const lines = source.split("\n");
  const findings: ActionNotConnected200Finding[] = [];
  let method: string | null = null;
  lines.forEach((l, i) => {
    const h = HANDLER.exec(l);
    if (h) method = h[1];
    if (!method || !ACTION_METHODS.has(method)) return;
    if (COMMENT.test(l) || !NOT_CONNECTED_BODY.test(l)) return;
    if (READ_VIA_POST[`${file} ${method}`]) return;
    // The call this body belongs to: this line through the end of the statement.
    let call = l;
    for (let j = i + 1; j < lines.length && j <= i + 6 && !/;\s*$/.test(call); j++) {
      call += "\n" + lines[j];
    }
    if (!ACTION_STATUS.test(call)) {
      findings.push({ file, method, line: i + 1, text: l.trim() });
    }
  });
  return findings;
}

describe("no action answers 200 { connected: false }", () => {
  it("scans every route handler's POST / PUT / PATCH / DELETE", () => {
    const routes = walk(path.join(ROOT, "src/app/api")).filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(100);
    const findings = routes.flatMap((f) =>
      findActionNotConnected200s(path.relative(ROOT, f), fs.readFileSync(f, "utf8")),
    );
    expect(
      findings.map((x) => `${x.file}:${x.line} ${x.method}  ${x.text}`),
    ).toEqual([]);
  });

  it("every READ_VIA_POST exemption still names a real POST handler", () => {
    for (const key of Object.keys(READ_VIA_POST)) {
      const [file, method] = key.split(" ");
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(src).toMatch(new RegExp(`export\\s+(?:async\\s+function\\s+|const\\s+)${method}\\b`));
    }
  });
});

describe("findActionNotConnected200s (the detector itself)", () => {
  const flagged = (src: string, file = "x.ts") => findActionNotConnected200s(file, src).length;

  it("flags the Teams send form: POST answering 200 { messages: [], connected: false }", () => {
    expect(
      flagged(`
export async function POST(req: NextRequest) {
  const token = await getValidToken(user.id);
  if (!token) {
    return NextResponse.json({ messages: [], connected: false });
  }
}`),
    ).toBe(1);
  });

  it("flags an explicit 200 and a helper body without a status", () => {
    expect(
      flagged(`
export const PATCH = async (req: Request) => {
  return NextResponse.json({ connected: false }, { status: 200 });
};`),
    ).toBe(1);
    expect(
      flagged(`
export async function DELETE(req: Request) {
  return NextResponse.json(
    notConnectedBody("microsoft"),
  );
}`),
    ).toBe(1);
  });

  it("does not flag a read, an action's 409, or providerNotConnected()", () => {
    expect(
      flagged(`
export async function GET(req: NextRequest) {
  if (!token) return NextResponse.json({ chats: [], connected: false });
}
export async function POST(req: NextRequest) {
  if (!token) return providerNotConnected(req, user, "microsoft");
  if (legacy) {
    return NextResponse.json(
      { connected: false, error: "microsoft_not_connected" },
      { status: 409 },
    );
  }
  const row = { m365_connected: false };
}`),
    ).toBe(0);
  });

  it("honours a READ_VIA_POST exemption only for its own file", () => {
    const src = `
export async function POST(req: NextRequest) {
  if (!token) return NextResponse.json({ presences: [], connected: false });
}`;
    expect(flagged(src, "src/app/api/ms/presence/route.ts")).toBe(0);
    expect(flagged(src, "src/app/api/other/route.ts")).toBe(1);
  });
});

describe("findProvider401s (the detector itself)", () => {
  const flagged = (src: string) => findProvider401s("x.ts", src).length;

  it("flags the switch-case form that /api/emails/inbox used", () => {
    expect(
      flagged(`
    switch (result.code) {
      case "not_connected":
        return NextResponse.json({ error: "microsoft_not_connected" }, { status: 401 });
    }`),
    ).toBe(1);
  });

  it("flags the multi-line case form (/api/mail/send)", () => {
    expect(
      flagged(`
      case "not_connected":
        return NextResponse.json(
          { error: "microsoft_not_connected" },
          { status: 401 },
        );`),
    ).toBe(1);
  });

  it("flags a Graph error class status passed through as 401 (/api/tasks, /api/files)", () => {
    expect(
      flagged(`
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });`),
    ).toBe(1);
    expect(
      flagged(`
      if (err.status === 401) {
        return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      }`),
    ).toBe(1);
  });

  it("flags the status-map ternary (/api/planner/*)", () => {
    expect(
      flagged(`
    const status =
      result.code === "not_connected" ? 401 :
      result.code === "scope_missing" ? 403 :
      502;`),
    ).toBe(1);
  });

  it("flags the forms executor mapping a forwarded not-connected to auth", () => {
    expect(
      flagged(`  if (status === 401) return failure("auth", "Microsoft account not connected.");`),
    ).toBe(1);
  });

  it("does not flag a genuine session 401", () => {
    expect(
      flagged(`
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });`),
    ).toBe(0);
    expect(
      flagged(`
  if (isProviderNotConnected(data)) return failure("not_connected", "Microsoft account not connected.");
  if (status === 401) return failure("auth", "Your session has expired. Sign in again.");`),
    ).toBe(0);
  });

  it("ignores comments that describe the old behavior", () => {
    expect(flagged(` *   401 { error: "microsoft_not_connected" }  (old)`)).toBe(0);
  });
});

/**
 * SECURITY REGRESSION CORPUS - the standing proof that the gate still catches bad code.
 *
 * WHY THIS EXISTS: every security detector was born from a real slip found by
 * dogfooding the code factory - a malicious change the gate let through until a
 * detector was added. A detector that is quietly broken, narrowed, or dropped
 * re-opens that hole SILENTLY: the scan goes green, the factory hands off, and
 * nobody learns the tool stopped catching the pattern until an attacker does.
 *
 * So every known-bad pattern lives here as a MUST-CATCH sample, and every
 * look-alike-but-safe pattern lives here as a MUST-NOT-FLAG sample. The corpus
 * runs in the normal jest suite (scripts/verify.sh, every PR and push), so:
 *   - if a detector drops/regresses, its MUST-CATCH sample goes red;
 *   - if a detector gets greedy, a MUST-NOT-FLAG sample goes red.
 *
 * ADDING A NEW DETECTOR: add at least one MUST_CATCH entry (the exploit) and one
 * CLEAN entry (the safe look-alike) here in the same change. This list is the
 * tool's self-test; keep it the source of truth for "what bad code we block."
 */
import { runDetectors } from "@/lib/platform-scan/static/detectors";

type Sev = "critical" | "high" | "medium" | "low";

interface BadSample {
  name: string;
  cwe: string;
  path: string;
  code: string;
  minSeverity: Sev;
  /** A substring expected in the matched finding's title (which detector fired). */
  titleIncludes: RegExp;
}

const SEV_RANK: Record<Sev, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * MUST-CATCH: each is a real vulnerability a model has authored (or trivially
 * could). The gate MUST surface a security finding at >= the listed severity.
 * `critical` entries additionally MUST block the factory handoff (deep-scan
 * blocks on critical), which the final assertion below checks as a group.
 */
const MUST_CATCH: BadSample[] = [
  {
    name: "eval() of input",
    cwe: "CWE-95",
    path: "src/lib/calc.ts",
    code: `export function calc(expr: string) {\n  return eval(expr);\n}`,
    minSeverity: "critical",
    titleIncludes: /code injection/i,
  },
  {
    name: "new Function() from input",
    cwe: "CWE-95",
    path: "src/lib/dyn.ts",
    code: `export const make = (body: string) => new Function("x", body);`,
    minSeverity: "critical",
    titleIncludes: /code injection/i,
  },
  {
    name: "SQL built by interpolation",
    cwe: "CWE-89",
    path: "src/lib/users.ts",
    code: "export const q = (id: string) => `SELECT * FROM users WHERE id = '${id}'`;",
    minSeverity: "critical",
    titleIncludes: /sql injection/i,
  },
  {
    name: "path traversal via concat",
    cwe: "CWE-22",
    path: "src/lib/readfile.ts",
    code: `import fs from "fs";\nexport const read = (name: string) => fs.readFileSync("./uploads/" + name, "utf8");`,
    minSeverity: "critical",
    titleIncludes: /path traversal/i,
  },
  {
    name: "path traversal via interpolation",
    cwe: "CWE-22",
    path: "src/lib/readfile2.ts",
    code: "import fs from \"fs\";\nexport const read = (name: string) => fs.readFileSync(`./uploads/${name}`, \"utf8\");",
    minSeverity: "critical",
    titleIncludes: /path traversal/i,
  },
  {
    name: "SSRF: request-derived URL",
    cwe: "CWE-918",
    path: "src/app/api/proxy/route.ts",
    code: `export async function GET(req: Request) {\n  const target = new URL(req.url).searchParams.get("u")!;\n  return new Response(await (await fetch(req.query.url)).text());\n}`,
    minSeverity: "critical",
    titleIncludes: /ssrf/i,
  },
  {
    name: "SSRF: url-named bare arg",
    cwe: "CWE-918",
    path: "src/lib/proxy.ts",
    code: `export const proxyGet = async (url: string) => (await fetch(url)).text();`,
    minSeverity: "critical",
    titleIncludes: /ssrf/i,
  },
  {
    name: "SSRF: scheme concatenated to host",
    cwe: "CWE-918",
    path: "src/lib/proxy2.ts",
    code: `export const get = (host: string) => fetch("https://" + host + "/v1");`,
    minSeverity: "critical",
    titleIncludes: /ssrf/i,
  },
  {
    name: "dynamic require of a variable",
    cwe: "CWE-98",
    path: "src/lib/plugin.ts",
    code: `export const load = (name: string) => require(name);`,
    minSeverity: "critical",
    titleIncludes: /dynamic module load/i,
  },
  {
    name: "dynamic import of a variable",
    cwe: "CWE-98",
    path: "src/lib/plugin2.ts",
    code: `export const load = (p: string) => import(p);`,
    minSeverity: "critical",
    titleIncludes: /dynamic module load/i,
  },
  {
    name: "insecure randomness for a reset token",
    cwe: "CWE-330",
    path: "src/lib/token.ts",
    code: `export function newResetToken() {\n  return Math.random().toString(36).slice(2);\n}`,
    minSeverity: "critical",
    titleIncludes: /insecure randomness/i,
  },
  {
    name: "prototype pollution via unguarded for..in copy",
    cwe: "CWE-1321",
    path: "src/lib/merge.ts",
    code: `export function merge(target: any, source: any) {\n  for (const k in source) target[k] = source[k];\n  return target;\n}`,
    minSeverity: "critical",
    titleIncludes: /prototype pollution/i,
  },
  {
    name: "hardcoded AWS access key",
    cwe: "CWE-798",
    path: "src/lib/aws.ts",
    code: `export const KEY = "AKIAIOSFODNN7EXAMPLE";`,
    minSeverity: "critical",
    titleIncludes: /hardcoded secret/i,
  },
  {
    name: "session token written to a log",
    cwe: "CWE-532",
    path: "src/app/api/login/route.ts",
    code: "export function log(sessionToken: string) {\n  console.log(`session ${sessionToken}`);\n}",
    minSeverity: "high",
    titleIncludes: /credential written to a log/i,
  },
  {
    name: "reset link written to a log",
    cwe: "CWE-532",
    path: "src/lib/reset.ts",
    code: "export function send(resetUrl: string) {\n  logger.info(`reset ${resetUrl}`);\n}",
    minSeverity: "high",
    titleIncludes: /credential written to a log/i,
  },
  {
    name: "XSS via dangerouslySetInnerHTML",
    cwe: "CWE-79",
    path: "src/components/Bio.tsx",
    code: `export const Bio = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;`,
    minSeverity: "high",
    titleIncludes: /xss/i,
  },
];

/**
 * MUST-NOT-FLAG: safe code that looks like one of the bad patterns. These keep
 * the detectors precise - a greedy rewrite that starts flagging these goes red
 * here, which is how a detector that would bury real findings in noise is caught.
 */
const CLEAN: { name: string; path: string; code: string }[] = [
  {
    name: "parameterized SQL (placeholders, not interpolation)",
    path: "src/lib/users-safe.ts",
    code: "export const q = (id: string) => query(`SELECT * FROM users WHERE id = $1`, [id]);",
  },
  {
    name: "obj.eval is not the global eval",
    path: "src/lib/safe-eval.ts",
    code: `export const run = (engine: { eval: (s: string) => unknown }, s: string) => engine.eval(s);`,
  },
  {
    name: "static file read against a fixed path",
    path: "src/lib/config.ts",
    code: `import fs from "fs";\nimport path from "path";\nexport const cfg = () => fs.readFileSync(path.join(__dirname, "config.json"), "utf8");`,
  },
  {
    name: "file read with basename() guard",
    path: "src/lib/read-safe.ts",
    code: `import fs from "fs";\nimport path from "path";\nexport const read = (name: string) => fs.readFileSync("./uploads/" + path.basename(name), "utf8");`,
  },
  {
    name: "fetch of a constant host with only a path interpolation",
    path: "src/lib/api-client.ts",
    code: "export const getUser = (id: string) => fetch(`https://api.example.com/users/${id}`);",
  },
  {
    name: "fetch of a string literal",
    path: "src/lib/ping.ts",
    code: `export const ping = () => fetch("https://api.example.com/health");`,
  },
  {
    name: "static require/import",
    path: "src/lib/static-require.ts",
    code: `const fs = require("fs");\nexport const lazy = () => import("./Chart");\nexport { fs };`,
  },
  {
    name: "Math.random for non-credential jitter",
    path: "src/lib/jitter.ts",
    code: `export const jitter = (ms: number) => ms + Math.floor(Math.random() * 100);`,
  },
  {
    name: "crypto-based token (the correct way)",
    path: "src/lib/token-safe.ts",
    code: `import { randomBytes } from "crypto";\nexport const newToken = () => randomBytes(32).toString("hex");`,
  },
  {
    name: "for..in copy guarded by hasOwnProperty",
    path: "src/lib/merge-safe.ts",
    code: `export function merge(target: any, source: any) {\n  for (const k in source) {\n    if (Object.prototype.hasOwnProperty.call(source, k) && k !== "__proto__") target[k] = source[k];\n  }\n  return target;\n}`,
  },
  {
    name: "logging a non-sensitive id",
    path: "src/lib/log-safe.ts",
    code: "export const log = (userId: string) => console.log(`user ${userId}`);",
  },
  {
    name: "JSON-LD via dangerouslySetInnerHTML (serialized data, not markup)",
    path: "src/components/Ld.tsx",
    code: `export const Ld = (d: object) => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(d) }} />;`,
  },
];

describe("security regression corpus - MUST-CATCH (a drop here means the gate stopped catching a real exploit)", () => {
  for (const s of MUST_CATCH) {
    it(`catches ${s.name} (${s.cwe}) at >= ${s.minSeverity}`, () => {
      const findings = runDetectors({ path: s.path, content: s.code });
      const match = findings.find((f) => s.titleIncludes.test(f.title));
      expect(match).toBeTruthy();
      expect(match!.category).toBe("security");
      expect(SEV_RANK[match!.severity as Sev]).toBeGreaterThanOrEqual(SEV_RANK[s.minSeverity]);
    });
  }
});

describe("security regression corpus - MUST-NOT-FLAG (a hit here means a detector got greedy and will bury real findings)", () => {
  for (const c of CLEAN) {
    it(`does not raise a security finding on: ${c.name}`, () => {
      const security = runDetectors({ path: c.path, content: c.code }).filter((f) => f.category === "security");
      expect(security).toEqual([]);
    });
  }
});

describe("security regression corpus - handoff gate coverage", () => {
  it("every `critical` exploit actually produces a critical finding (deep-scan blocks on critical > 0)", () => {
    // deepScanChange sets blocking = critical > 0, so only a critical finding
    // withholds the handoff. Assert the critical corpus entries each reach it.
    for (const s of MUST_CATCH.filter((m) => m.minSeverity === "critical")) {
      const crit = runDetectors({ path: s.path, content: s.code }).some(
        (f) => f.severity === "critical" && s.titleIncludes.test(f.title),
      );
      expect(crit).toBe(true);
    }
  });

  it("the corpus covers every security detector wired into runDetectors", () => {
    // If a new security detector is added without a MUST-CATCH sample, this fails -
    // the corpus must grow with the detectors it guards.
    const titles = MUST_CATCH.map((m) => m.titleIncludes);
    const requiredFamilies = [
      /code injection/i,
      /sql injection/i,
      /path traversal/i,
      /ssrf/i,
      /dynamic module load/i,
      /insecure randomness/i,
      /prototype pollution/i,
      /hardcoded secret/i,
      /credential written to a log/i,
      /xss/i,
    ];
    for (const fam of requiredFamilies) {
      expect(titles.some((t) => t.source === fam.source)).toBe(true);
    }
  });
});

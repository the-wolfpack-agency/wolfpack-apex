/**
 * Unit coverage for parseSarif: the tool-agnostic SARIF -> ScanFinding mapping.
 *
 * Exercises the realistic Semgrep shape (numeric security-severity, level
 * fallback, rule-resolved name + tags, category inference), scannedRoutes dedup
 * across results + run.artifacts, a gitleaks-style secret rule, and the
 * defensive paths (empty + malformed SARIF never throw, yield no findings).
 */
import { parseSarif } from "../sarif";

// A realistic Semgrep SARIF 2.1.0 with two results:
//  - a security rule (security-severity "8.5" -> high, tags -> security)
//  - a generic rule (level "warning", no score -> medium, no tokens -> bug)
const SEMGREP_SARIF = {
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "semgrep",
          rules: [
            {
              id: "javascript.express.security.audit.xss",
              name: "Reflected XSS in response",
              properties: { tags: ["security", "OWASP-A03", "CWE-79"] },
            },
            {
              id: "javascript.lang.correctness.useless-eq",
              name: "Useless equality check",
              properties: { tags: ["correctness"] },
            },
          ],
        },
      },
      artifacts: [
        { location: { uri: "src/handlers.js" } },
        { location: { uri: "src/util.js" } },
        // A clean file the scan covered but did not flag.
        { location: { uri: "src/clean.js" } },
      ],
      results: [
        {
          ruleId: "javascript.express.security.audit.xss",
          level: "error",
          message: { text: "User input flows into the response body." },
          properties: { "security-severity": "8.5" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/handlers.js" },
                region: { startLine: 42, snippet: { text: "  res.send(req.query.q)  " } },
              },
            },
          ],
        },
        {
          ruleId: "javascript.lang.correctness.useless-eq",
          level: "warning",
          message: { text: "This comparison is always true." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/util.js" },
                region: { startLine: 7 },
              },
            },
          ],
        },
      ],
    },
  ],
};

describe("parseSarif (Semgrep)", () => {
  const result = parseSarif(SEMGREP_SARIF, "wolfpack-auto");

  it("sets platform + baseUrl from the tool name", () => {
    expect(result.platform).toBe("wolfpack-auto");
    expect(result.baseUrl).toBe("sarif:semgrep");
  });

  it("maps the security result: route, high severity, security category, title", () => {
    const xss = result.findings.find((f) => f.route === "src/handlers.js");
    expect(xss).toBeDefined();
    expect(xss!.severity).toBe("high"); // security-severity 8.5 -> high
    expect(xss!.category).toBe("security");
    expect(xss!.title).toBe("Reflected XSS in response"); // resolved rule name
    expect(xss!.detail).toBe(
      "User input flows into the response body. (rule: javascript.express.security.audit.xss)",
    );
    expect(xss!.evidence).toEqual({
      line: 42,
      ruleId: "javascript.express.security.audit.xss",
      tool: "semgrep",
      snippet: "res.send(req.query.q)", // trimmed
    });
  });

  it("maps the generic result: medium (level warning fallback), bug category", () => {
    const eq = result.findings.find((f) => f.route === "src/util.js");
    expect(eq).toBeDefined();
    expect(eq!.severity).toBe("medium"); // no score -> level warning -> medium
    expect(eq!.category).toBe("bug");
    expect(eq!.title).toBe("Useless equality check");
    expect(eq!.evidence.line).toBe(7);
    expect(eq!.evidence.snippet).toBe(""); // no snippet present
  });

  it("evidence values are scalar-only", () => {
    for (const f of result.findings) {
      for (const v of Object.values(f.evidence)) {
        expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
      }
    }
  });

  it("scannedRoutes unions result uris + run.artifacts and dedupes", () => {
    expect(result.scannedRoutes).toBeDefined();
    const set = new Set(result.scannedRoutes);
    expect(set).toEqual(new Set(["src/handlers.js", "src/util.js", "src/clean.js"]));
    // dedupe: handlers.js appears in both a result and artifacts -> once.
    expect(result.scannedRoutes!.length).toBe(3);
  });

  it("counts: routeCount = covered files, okCount excludes flagged files", () => {
    expect(result.routeCount).toBe(3);
    expect(result.okCount).toBe(1); // 3 covered - 2 flagged
  });
});

describe("parseSarif (gitleaks-style secret rule)", () => {
  const GITLEAKS_SARIF = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "gitleaks" } }, // no rules[] -> infer from ruleId
        results: [
          {
            ruleId: "aws-access-token-secret",
            level: "error",
            message: { text: "AWS access token detected." },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: ".env" },
                  region: { startLine: 3 },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it("infers security category from a ruleId containing 'secret'", () => {
    const result = parseSarif(GITLEAKS_SARIF, "wolfpack-auto");
    expect(result.baseUrl).toBe("sarif:gitleaks");
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0];
    expect(f.route).toBe(".env");
    expect(f.category).toBe("security");
    expect(f.severity).toBe("high"); // level error
    expect(f.title).toBe("aws-access-token-secret"); // ruleId as title (no rule name)
  });
});

describe("parseSarif (defensive)", () => {
  it("empty SARIF -> no findings, no throw", () => {
    const result = parseSarif({ version: "2.1.0", runs: [] }, "p");
    expect(result.findings).toEqual([]);
    expect(result.scannedRoutes).toEqual([]);
  });

  it("malformed SARIF (missing runs) -> no findings, no throw", () => {
    expect(() => parseSarif({ not: "sarif" }, "p")).not.toThrow();
    expect(parseSarif({ not: "sarif" }, "p").findings).toEqual([]);
  });

  it("non-object / null SARIF -> no findings, no throw", () => {
    expect(parseSarif(null, "p").findings).toEqual([]);
    expect(parseSarif("nope", "p").findings).toEqual([]);
    expect(parseSarif(42, "p").findings).toEqual([]);
  });

  it("result with no location -> route '(unknown)', not counted as covered", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { name: "trivy" } },
          results: [{ ruleId: "x", message: { text: "no loc" } }],
        },
      ],
    };
    const result = parseSarif(sarif, "p");
    expect(result.findings[0].route).toBe("(unknown)");
    expect(result.scannedRoutes).toEqual([]); // (unknown) is not a covered route
  });
});

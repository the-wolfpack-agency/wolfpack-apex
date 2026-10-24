import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  chunk,
  dependabotFindings,
  ghostActionFindings,
  matchKnownImages,
  matchKnownPackages,
  osvFindings,
  osvQueries,
  osvSeverity,
  type KnownCompromised,
  type WorkflowCommit,
} from "../../../scripts/security/lib/supply-chain";
import { parseImageRefs, parsePackageLock, parseRequirements } from "../../../scripts/security/lib/lockfiles";

const KNOWN = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "security", "known-compromised.json"), "utf8"),
) as KnownCompromised;

describe("security/known-compromised.json", () => {
  it("lists this week's incidents, each with an https primary source", () => {
    const names = KNOWN.packages.map((p) => `${p.ecosystem}:${p.name}`);
    expect(names).toEqual(
      expect.arrayContaining(["PyPI:litellm", "npm:@subql/common", "npm:tensorlake", "npm:@apexacc/cli", "npm:@apexacc/audit"]),
    );
    for (const p of KNOWN.packages) {
      expect(["npm", "PyPI"]).toContain(p.ecosystem);
      expect(p.versions.length).toBeGreaterThan(0);
      expect(p.sources.length).toBeGreaterThan(0);
      for (const s of p.sources) expect(s).toMatch(/^https:\/\//);
    }
    for (const i of KNOWN.images) for (const s of i.sources) expect(s).toMatch(/^https:\/\//);
    expect(new Set(KNOWN.packages.map((p) => p.id)).size).toBe(KNOWN.packages.length);
  });

  it("contains no em dashes", () => {
    const raw = readFileSync(join(__dirname, "..", "..", "..", "security", "known-compromised.json"), "utf8");
    expect(raw.includes(String.fromCharCode(0x2014))).toBe(false);
  });
});

describe("matchKnownPackages", () => {
  it("flags the exact compromised versions and every version of an all-malicious package", () => {
    const lock = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/@subql/common": { version: "5.8.3" },
          "node_modules/tensorlake": { version: "0.5.145" },
          "node_modules/@apexacc/cli": { version: "9.9.9" },
        },
      }),
    );
    const f = matchKnownPackages("org/repo", "package-lock.json", lock, KNOWN.packages);
    expect(f.map((x) => x.detail.split(" ")[0])).toEqual(["@subql/common@5.8.3", "@apexacc/cli@9.9.9"]);
    expect(f.every((x) => x.severity === "critical")).toBe(true);
  });

  it("matches PyPI names after normalization and leaves safe versions alone", () => {
    const reqs = parseRequirements("LiteLLM==1.107.0\nlitellm==1.106.2\n");
    const f = matchKnownPackages("org/repo", "requirements.txt", reqs, KNOWN.packages);
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("litellm@1.107.0");
    expect(f[0].detail).toContain("1.106.2");
  });
});

describe("matchKnownImages", () => {
  it("is critical for the bad tag or digest, low for a moving tag, silent for a pinned safe tag", () => {
    const refs = parseImageRefs(
      [
        "FROM ghcr.io/berriai/litellm:v1.107.0",
        "FROM ghcr.io/berriai/litellm@sha256:1bbcb1443bc962e45f5aad53fe3d2c30600e0379715fb6c664cdd3ac126c339e",
        "FROM docker.io/litellm/litellm:main-stable",
        "FROM ghcr.io/berriai/litellm:v1.106.2",
      ].join("\n"),
    );
    const f = matchKnownImages("org/repo", "Dockerfile", refs, KNOWN.images);
    expect(f.map((x) => x.severity)).toEqual(["critical", "critical", "low"]);
  });
});

describe("OSV", () => {
  it("builds one query per package and batches at the API limit", () => {
    const q = osvQueries([{ ecosystem: "npm", name: "a", version: "1.0.0" }]);
    expect(q).toEqual([{ package: { ecosystem: "npm", name: "a" }, version: "1.0.0" }]);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("treats MAL- as critical, maps GHSA severities, and ignores withdrawn records", () => {
    expect(osvSeverity({ id: "MAL-2026-2144" })).toBe("critical");
    expect(osvSeverity({ id: "GHSA-x", database_specific: { severity: "HIGH" } })).toBe("high");
    expect(osvSeverity({ id: "GHSA-y", database_specific: { severity: "MODERATE" } })).toBe("medium");
    expect(osvSeverity({ id: "PYSEC-z" })).toBeNull();
    expect(osvSeverity({ id: "GHSA-w", withdrawn: "2026-01-01", database_specific: { severity: "HIGH" } })).toBeNull();
  });

  it("reports a malicious package as osv.malicious and skips moderate-only packages", () => {
    const pkg = { ecosystem: "npm" as const, name: "@subql/common", version: "5.8.3" };
    const details = new Map([["GHSA-m", { id: "GHSA-m", database_specific: { severity: "MODERATE" } }]]);
    const mal = osvFindings("org/r", "package-lock.json", pkg, ["MAL-2026-17571", "GHSA-m"], details);
    expect(mal?.rule).toBe("osv.malicious");
    expect(mal?.severity).toBe("critical");
    expect(osvFindings("org/r", "package-lock.json", pkg, ["GHSA-m"], details)).toBeNull();
  });
});

describe("dependabotFindings", () => {
  it("lists malware, critical and high; counts the rest; drops withdrawn", () => {
    const { findings, counts } = dependabotFindings("org/r", [
      { number: 1, security_advisory: { severity: "low", classification: "malware", ghsa_id: "GHSA-mal" }, dependency: { package: { name: "evil" } } },
      { number: 2, security_advisory: { severity: "critical", ghsa_id: "GHSA-c" } },
      { number: 3, security_advisory: { severity: "high", ghsa_id: "GHSA-h" } },
      { number: 4, security_advisory: { severity: "medium", ghsa_id: "GHSA-m" } },
      { number: 5, security_advisory: { severity: "high", ghsa_id: "GHSA-w", withdrawn_at: "2026-10-01" } },
    ]);
    expect(findings.map((f) => f.rule)).toEqual(["dependabot.malware", "dependabot.critical", "dependabot.high"]);
    expect(findings[0].severity).toBe("critical");
    expect(counts).toMatchObject({ malware: 1, critical: 1, high: 1, medium: 1, withdrawn: 1 });
  });
});

describe("ghostActionFindings", () => {
  const commit = (over: Partial<WorkflowCommit>): WorkflowCommit => ({
    sha: "abcdef1234567890",
    refs: ["main"],
    onDefaultBranch: true,
    author: "someone",
    committedAt: "2026-10-20T00:00:00Z",
    message: "add security audit",
    workflowFiles: [".github/workflows/ci.yml"],
    pulls: [],
    ...over,
  });

  it("passes a commit that is part of a merged PR", () => {
    expect(ghostActionFindings("o/r", [commit({ pulls: [{ number: 1, state: "closed", merged_at: "2026-10-20" }] })], [])).toEqual([]);
  });

  it("grades direct pushes, PR-less branches and open PRs differently", () => {
    const f = ghostActionFindings(
      "o/r",
      [
        commit({}),
        commit({ sha: "b".repeat(16), onDefaultBranch: false, refs: ["x"] }),
        commit({ sha: "c".repeat(16), onDefaultBranch: false, refs: ["y"], pulls: [{ number: 9, state: "open", merged_at: null }] }),
      ],
      [],
    );
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["ghostaction.direct-push", "high"],
      ["ghostaction.no-pr", "medium"],
      ["ghostaction.unmerged-pr", "low"],
    ]);
  });

  it("raises severity one step when the filename is a known campaign indicator", () => {
    const f = ghostActionFindings(
      "o/r",
      [commit({ onDefaultBranch: false, refs: ["x"], workflowFiles: [".github/workflows/security-audit.yml"] })],
      KNOWN.workflowIndicators,
    );
    expect(f[0].severity).toBe("high");
    expect(f[0].detail).toContain("security-audit.yml");
  });
});

/**
 * Pattern matcher for security:public-artifacts.
 *
 * Every credential below is SYNTHETIC and assembled at runtime from pieces, so
 * this file holds no literal that a secret scanner (ours or GitHub's push
 * protection) would read as a real key.
 */
import {
  CREDENTIAL_PATTERNS,
  createdWithin,
  isRateLimited,
  rateLimitFinding,
  deleteCommand,
  hitFinding,
  isZipHeader,
  notScannedFinding,
  oversizeFinding,
  runUrl,
  scanText,
  toArtifactRefs,
  unzipListedBytes,
  type ArtifactRef,
} from "../../../scripts/security/lib/public-artifacts";

const j = (...parts: string[]) => parts.join("");
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

const SYN = {
  jwt: j(b64url({ alg: "HS256", typ: "JWT" }), ".", b64url({ sub: "synthetic-user", role: "cto" }), ".", "c2lnbmF0dXJlLXN5bnRoZXRpYw"),
  refreshId: "0b5f2c1e-9a4d-4f7e-8c3b-1d2e3f4a5b6c",
  ghp: j("gh", "p_", "Ab1".repeat(12)),
  githubPat: j("github", "_pat_", "11ABCDEFG0", "x".repeat(20), "_", "Y9".repeat(20)),
  sk: j("s", "k-", "proj-", "Qw3rTy", "Zx9".repeat(10)),
  akia: j("AK", "IA", "SYNTHETIC0000000"),
  slack: j("https://hooks.", "slack.com/services/", "TSYNTH001", "/", "BSYNTH002", "/", "abcdEFGHijklMNOP1234"),
  pg: j("postgres", "://app_user:", "Hq8vR2-synthetic", "@ep-synthetic-123.us-east-2.aws.neon.tech/neondb?sslmode=require"),
};

const names = (text: string) => scanText(text).map((h) => h.pattern);

describe("scanText true positives (one per pattern)", () => {
  it.each([
    ["jwt", `{"token":"${SYN.jwt}"}`],
    ["instinct-session-cookie", `cookie: instinct_refresh_token=${SYN.refreshId}; Path=/`],
    ["instinct-session-cookie", `Cookie: instinct_access_token=${SYN.jwt}`],
    ["instinct-session-cookie-json", `{"cookies":[{"name":"instinct_refresh_token","value":"${SYN.refreshId}","domain":"x"}]}`],
    ["authorization-bearer", `Authorization: Bearer ${SYN.jwt}`],
    ["authorization-bearer-json", `{"name":"authorization","value":"Bearer ${SYN.jwt}"}`],
    ["github-pat-classic", `token=${SYN.ghp}`],
    ["github-pat-fine-grained", `GH_TOKEN=${SYN.githubPat}`],
    ["sk-api-key", `OPENAI_API_KEY=${SYN.sk}`],
    ["aws-access-key-id", `aws_access_key_id = ${SYN.akia}`],
    ["slack-webhook", `url: ${SYN.slack}`],
    ["postgres-url-with-password", `DATABASE_URL=${SYN.pg}`],
  ])("%s", (pattern, text) => {
    expect(names(text)).toContain(pattern);
  });

  it("covers every declared pattern in the cases above", () => {
    const declared = CREDENTIAL_PATTERNS.map((p) => p.name).sort();
    expect(declared).toEqual(
      [
        "authorization-bearer",
        "authorization-bearer-json",
        "aws-access-key-id",
        "github-pat-classic",
        "github-pat-fine-grained",
        "instinct-session-cookie",
        "instinct-session-cookie-json",
        "jwt",
        "postgres-url-with-password",
        "sk-api-key",
        "slack-webhook",
      ].sort(),
    );
  });

  it("counts repeated matches", () => {
    const hits = scanText(`${SYN.jwt}\n${SYN.jwt}\n${SYN.jwt}`);
    expect(hits.find((h) => h.pattern === "jwt")?.count).toBe(3);
  });

  it("rates session cookies, bearer tokens and password URLs critical, the rest high", () => {
    const sev = Object.fromEntries(CREDENTIAL_PATTERNS.map((p) => [p.name, p.severity]));
    for (const n of ["instinct-session-cookie", "instinct-session-cookie-json", "authorization-bearer", "authorization-bearer-json", "postgres-url-with-password"]) {
      expect(sev[n]).toBe("critical");
    }
    for (const n of ["jwt", "github-pat-classic", "github-pat-fine-grained", "sk-api-key", "aws-access-key-id", "slack-webhook"]) {
      expect(sev[n]).toBe("high");
    }
  });
});

describe("scanText true negatives", () => {
  it("ignores eyJ inside base64 image data that is not a JWT", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJeyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxIn0AAAAASUVORK5CYII=";
    expect(names(png)).toEqual([]);
  });

  it("ignores Postgres URLs without a password, with placeholders, or on CI service hosts", () => {
    expect(names("See https://www.postgresql.org/docs/current/libpq-connect.html and postgres://app@db.example.com/app")).toEqual([]);
    expect(names("postgresql://localhost/test")).toEqual([]);
    expect(names(j("postgres", "://user:password@host.example.com/db"))).toEqual([]);
    expect(names(j("postgres", "://user:${PGPASSWORD}@host.example.com/db"))).toEqual([]);
    expect(names(j("postgres", "://postgres:s3cr3tCI@localhost:5432/test"))).toEqual([]);
  });

  it("ignores a cleared cookie, a bare 'Bearer' word and CSS-like sk- slugs", () => {
    expect(names("Set-Cookie: instinct_access_token=; Max-Age=0")).toEqual([]);
    expect(names("The Authorization header uses the Bearer scheme.")).toEqual([]);
    expect(names('class="sk-fading-circle-container-outer"')).toEqual([]);
    expect(names("task-list-item-checkbox-wrapper-element")).toEqual([]);
  });

  it("ignores AWS's documentation key and a JWT lookalike whose payload is not JSON", () => {
    expect(names(j("AKIA", "IOSFODNN7", "EXAMPLE"))).toEqual([]);
    expect(names(j("eyJhbGciOiJIUzI1", ".", "eyJ", "notbase64json!!".replace(/!/g, "x"), "zzzz", ".", "sig"))).toEqual([]);
  });

  it("ignores ordinary uppercase words and short ghp_ strings", () => {
    expect(names("AKIA is the prefix of an AWS key id; ghp_ prefixes classic tokens.")).toEqual([]);
  });
});

describe("redaction", () => {
  const a: ArtifactRef = { repo: "the-wolfpack-agency/wolfpack-apex", id: 42, name: "playwright-report", createdAt: "2026-10-20T10:00:00Z", sizeBytes: 1000, runId: 777 };

  it("never puts the matched value in a hit or a finding", () => {
    const all = Object.values(SYN);
    const text = [
      `instinct_refresh_token=${SYN.refreshId}`,
      `Authorization: Bearer ${SYN.jwt}`,
      SYN.ghp,
      SYN.githubPat,
      SYN.sk,
      SYN.akia,
      SYN.slack,
      SYN.pg,
    ].join("\n");
    const hits = scanText(text);
    expect(hits.length).toBeGreaterThanOrEqual(8);
    const serialized = JSON.stringify(hits) + JSON.stringify(hits.map((h) => hitFinding(a, "data/trace.network", h)));
    for (const v of all) expect(serialized).not.toContain(v);
    // Not even a recognizable fragment of the secret part.
    expect(serialized).not.toContain(SYN.refreshId.slice(0, 8));
    expect(serialized).not.toContain("Hq8vR2");
  });

  it("records repo, artifact name, id, created date, file path and pattern name", () => {
    const f = hitFinding(a, "trace.zip/trace.network", { pattern: "instinct-session-cookie", severity: "critical", count: 2 });
    expect(f.severity).toBe("critical");
    expect(f.rule).toBe("artifact.instinct-session-cookie");
    expect(f.subject).toContain("the-wolfpack-agency/wolfpack-apex");
    expect(f.subject).toContain("playwright-report");
    expect(f.subject).toContain("id 42");
    expect(f.subject).toContain("2026-10-20");
    expect(f.detail).toContain("trace.zip/trace.network");
    expect(f.detail).toContain(deleteCommand(a));
    expect(f.detail).toContain("security:revoke-session");
    expect(f.source).toBe("https://github.com/the-wolfpack-agency/wolfpack-apex/actions/runs/777");
  });

  it("tells the human how to delete without deleting", () => {
    expect(deleteCommand(a)).toBe("gh api -X DELETE repos/the-wolfpack-agency/wolfpack-apex/actions/artifacts/42");
    expect(runUrl({ ...a, runId: null })).toBe("https://github.com/the-wolfpack-agency/wolfpack-apex/actions");
  });

  it("reports an oversized or unreadable artifact instead of passing it silently", () => {
    expect(oversizeFinding({ ...a, sizeBytes: 80 * 1048576 }, 50 * 1048576).rule).toBe("artifact.not-scanned-too-large");
    expect(notScannedFinding(a, "download failed (403)").severity).toBe("medium");
  });
});

describe("archive helpers", () => {
  it("recognizes a zip header (nested Playwright trace.zip)", () => {
    expect(isZipHeader(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(isZipHeader(new Uint8Array([0x7b, 0x22]))).toBe(false);
  });

  it("reads the total from unzip -l, and refuses to guess when it cannot", () => {
    const listing = "Archive:  a.zip\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n     1234  10-20-2026 10:00   trace.zip\n---------                     -------\n     1234                     1 file\n";
    expect(unzipListedBytes(listing)).toBe(1234);
    expect(unzipListedBytes("garbage")).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps only unexpired artifacts and carries the run id", () => {
    const refs = toArtifactRefs("o/r", [
      { id: 1, name: "a", size_in_bytes: 10, expired: false, created_at: "2026-10-01T00:00:00Z", workflow_run: { id: 9 } },
      { id: 2, name: "b", size_in_bytes: 10, expired: true, created_at: "2026-01-01T00:00:00Z", workflow_run: null },
    ]);
    expect(refs).toEqual([{ repo: "o/r", id: 1, name: "a", createdAt: "2026-10-01T00:00:00Z", sizeBytes: 10, runId: 9 }]);
  });
});

describe("rate limits and the --days window", () => {
  const mk = (id: number, createdAt: string): ArtifactRef => ({ repo: "o/r", id, name: "n", createdAt, sizeBytes: 1, runId: 1 });

  it("recognizes GitHub's rate-limit answers and nothing else", () => {
    expect(isRateLimited(403, "API rate limit exceeded for user ID 1 (HTTP 403)")).toBe(true);
    expect(isRateLimited(403, "You have exceeded a secondary rate limit")).toBe(true);
    expect(isRateLimited(429, "")).toBe(true);
    expect(isRateLimited(403, "Resource not accessible by integration")).toBe(false);
    expect(isRateLimited(404, "rate limit")).toBe(false);
  });

  it("reports everything a rate limit left unscanned as ONE finding", () => {
    const f = rateLimitFinding([mk(1, "2026-10-24T00:00:00Z"), mk(2, "2026-10-24T00:00:00Z"), { ...mk(3, "2026-10-24T00:00:00Z"), repo: "o/a" }]);
    expect(f).toMatchObject({ severity: "medium", rule: "artifact.scan-incomplete-rate-limited", subject: "o/a, o/r" });
    expect(f.detail).toContain("3 artifact(s) were NOT scanned");
  });

  it("keeps only artifacts created inside the window", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const refs = [mk(1, "2026-10-24T06:00:00Z"), mk(2, "2026-10-22T06:00:00Z")];
    expect(createdWithin(refs, 1, now).map((a) => a.id)).toEqual([1]);
    expect(createdWithin(refs, null, now)).toHaveLength(2);
  });
});

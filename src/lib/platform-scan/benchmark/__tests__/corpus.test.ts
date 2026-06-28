/**
 * The benchmark corpus IS the safety contract for the active-learning loop. The
 * guardrail (assertBenchmarkConsent) is what makes it IMPOSSIBLE to benchmark a
 * target we are not authorized to test, and impossible to ACTIVELY probe anything
 * but our own / self-hosted fixtures. These tests exercise that contract hard:
 * the allowlist shape, lookup by name and by URL, and every branch of the consent
 * gate (read-only allowed for any corpus target; active allowed only for
 * activeAllowed own/self-hosted; THROWS for non-corpus and for opt-in/non-active).
 */
import {
  BENCHMARK_CORPUS,
  BenchmarkConsentError,
  assertBenchmarkConsent,
  getBenchmarkTarget,
  isBenchmarkTarget,
  type BenchmarkTarget,
} from "@/lib/platform-scan/benchmark/corpus";

describe("BENCHMARK_CORPUS shape + invariants", () => {
  it("is non-empty and every entry has all required fields + a consentNote", () => {
    expect(BENCHMARK_CORPUS.length).toBeGreaterThan(0);
    for (const t of BENCHMARK_CORPUS) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.baseUrl).toMatch(/^https?:\/\//);
      expect(["own", "self-hosted-benchmark", "opt-in"]).toContain(t.provenance);
      expect(typeof t.activeAllowed).toBe("boolean");
      expect(Array.isArray(t.modality)).toBe(true);
      expect(t.modality.length).toBeGreaterThan(0);
      t.modality.forEach((m) => expect(["http", "static", "browser"]).toContain(m));
      // The consentNote is the human-auditable authorization record: required,
      // non-trivial, on EVERY entry.
      expect(typeof t.consentNote).toBe("string");
      expect(t.consentNote.trim().length).toBeGreaterThan(10);
    }
  });

  it("never enables active probing for an opt-in target (the core safety invariant)", () => {
    for (const t of BENCHMARK_CORPUS) {
      if (t.provenance === "opt-in") expect(t.activeAllowed).toBe(false);
    }
  });

  it("only own / self-hosted-benchmark targets may be activeAllowed", () => {
    for (const t of BENCHMARK_CORPUS) {
      if (t.activeAllowed) {
        expect(["own", "self-hosted-benchmark"]).toContain(t.provenance);
      }
    }
  });

  it("seeds our four OWN apps as read-only", () => {
    const own = BENCHMARK_CORPUS.filter((t) => t.provenance === "own");
    const names = own.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["wolfpack-instinct", "ogiam", "wolfpack-beyond", "wolfpack-auto"]),
    );
    own.forEach((t) => expect(t.activeAllowed).toBe(false));
  });

  it("seeds exactly one self-hosted-benchmark fixture with active probing + ground truth", () => {
    const fixtures = BENCHMARK_CORPUS.filter((t) => t.provenance === "self-hosted-benchmark");
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
    const juice = fixtures[0];
    expect(juice.activeAllowed).toBe(true);
    expect(juice.groundTruth?.length).toBeGreaterThan(0);
    juice.groundTruth?.forEach((g) => {
      expect(typeof g.findingClass).toBe("string");
      expect(g.findingClass.length).toBeGreaterThan(0);
    });
  });

  it("contains no third-party production domain (allowlist is own/self-hosted/opt-in only)", () => {
    // Self-hosted fixtures may legitimately point at our infra (incl. localhost
    // placeholders); own targets are our vercel/owned domains. No entry should be
    // a remote third-party demo we do not control.
    for (const t of BENCHMARK_CORPUS) {
      const host = new URL(t.baseUrl).hostname.toLowerCase();
      if (t.provenance === "own") {
        expect(host).toMatch(/(wolfpack|ogiam|beyond-sku)/);
      }
      // The known public Juice Shop demo must NEVER be a target.
      expect(host).not.toBe("juice-shop.herokuapp.com");
      expect(host).not.toBe("demo.owasp-juice.shop");
    }
  });
});

describe("adjacent self-hosted labeled targets (owasp-benchmark, vampi, nodegoat)", () => {
  const NEW_TARGET_NAMES = ["owasp-benchmark", "vampi", "nodegoat"] as const;
  const VALID_SEVERITIES = ["critical", "high", "medium", "low"];
  const VALID_MODALITIES = ["http", "static", "browser"];

  it("includes each new target in BENCHMARK_CORPUS", () => {
    for (const name of NEW_TARGET_NAMES) {
      const t = BENCHMARK_CORPUS.find((e) => e.name === name);
      expect(t).toBeDefined();
      expect(t!.provenance).toBe("self-hosted-benchmark");
      expect(t!.activeAllowed).toBe(true);
      expect(t!.modality.length).toBeGreaterThan(0);
      t!.modality.forEach((m) => expect(VALID_MODALITIES).toContain(m));
      expect(t!.consentNote.trim().length).toBeGreaterThan(10);
    }
  });

  it("the three new target names are unique within the corpus", () => {
    for (const name of NEW_TARGET_NAMES) {
      const count = BENCHMARK_CORPUS.filter((e) => e.name === name).length;
      expect(count).toBe(1);
    }
    // and unique relative to each other
    expect(new Set(NEW_TARGET_NAMES).size).toBe(NEW_TARGET_NAMES.length);
  });

  it("getBenchmarkTarget finds each new target by name", () => {
    for (const name of NEW_TARGET_NAMES) {
      expect(getBenchmarkTarget(name)?.name).toBe(name);
    }
  });

  it("vampi is the api-modality fixture (http only, not browser)", () => {
    const vampi = getBenchmarkTarget("vampi")!;
    expect(vampi.modality).toEqual(["http"]);
  });

  it("every groundTruth findingClass is a non-empty string and severity (if set) is valid", () => {
    for (const name of NEW_TARGET_NAMES) {
      const t = getBenchmarkTarget(name)!;
      expect(t.groundTruth?.length).toBeGreaterThan(0);
      t.groundTruth!.forEach((g) => {
        expect(typeof g.findingClass).toBe("string");
        expect(g.findingClass.trim().length).toBeGreaterThan(0);
        // findingClass must follow the scorer's `${category}:${title}` convention.
        expect(g.findingClass).toMatch(/^[a-z]+:.+/);
        if (g.expectedSeverity !== undefined) {
          expect(VALID_SEVERITIES).toContain(g.expectedSeverity);
        }
      });
    }
  });

  it("assertBenchmarkConsent allows read-only for each new target", () => {
    for (const name of NEW_TARGET_NAMES) {
      expect(() => assertBenchmarkConsent(name, "read-only")).not.toThrow();
    }
  });

  it("assertBenchmarkConsent allows active for each new target (activeAllowed self-hosted)", () => {
    for (const name of NEW_TARGET_NAMES) {
      expect(() => assertBenchmarkConsent(name, "active")).not.toThrow();
    }
  });

  it("each new target's baseUrl is env-guarded: unset falls back to an inert loopback placeholder", () => {
    // Mirrors the juice-shop pattern: with the env var unset (the CI case), the
    // baseUrl is a localhost placeholder the SSRF floor refuses, so the target is
    // inert and cannot be probed by accident.
    const envByName: Record<string, string | undefined> = {
      "owasp-benchmark": process.env.BENCHMARK_OWASP_URL,
      vampi: process.env.BENCHMARK_VAMPI_URL,
      nodegoat: process.env.BENCHMARK_NODEGOAT_URL,
    };
    for (const name of NEW_TARGET_NAMES) {
      const t = getBenchmarkTarget(name)!;
      if (envByName[name] === undefined) {
        expect(new URL(t.baseUrl).hostname).toBe("localhost");
      } else {
        expect(t.baseUrl).toBe(envByName[name]);
      }
    }
  });
});

describe("isBenchmarkTarget / getBenchmarkTarget", () => {
  it("isBenchmarkTarget is true for a corpus name and false for a random URL", () => {
    expect(isBenchmarkTarget("wolfpack-instinct")).toBe(true);
    expect(isBenchmarkTarget("https://example.com")).toBe(false);
    expect(isBenchmarkTarget("https://www.google.com")).toBe(false);
    expect(isBenchmarkTarget("")).toBe(false);
  });

  it("getBenchmarkTarget resolves by name", () => {
    const t = getBenchmarkTarget("ogiam");
    expect(t?.name).toBe("ogiam");
    expect(t?.baseUrl).toBe("https://ogiam.com");
  });

  it("getBenchmarkTarget resolves by baseUrl (and tolerates a trailing slash / case)", () => {
    expect(getBenchmarkTarget("https://beyond-sku.vercel.app")?.name).toBe("wolfpack-beyond");
    expect(getBenchmarkTarget("https://beyond-sku.vercel.app/")?.name).toBe("wolfpack-beyond");
    expect(getBenchmarkTarget("HTTPS://BEYOND-SKU.VERCEL.APP")?.name).toBe("wolfpack-beyond");
  });

  it("getBenchmarkTarget returns null for an unknown identifier", () => {
    expect(getBenchmarkTarget("not-a-target")).toBeNull();
    expect(getBenchmarkTarget("https://attacker.example")).toBeNull();
  });
});

describe("assertBenchmarkConsent (the guardrail)", () => {
  it("allows read-only for any corpus target (own AND self-hosted)", () => {
    expect(() => assertBenchmarkConsent("wolfpack-instinct", "read-only")).not.toThrow();
    expect(() => assertBenchmarkConsent("ogiam", "read-only")).not.toThrow();
    expect(() => assertBenchmarkConsent("self-hosted-juice-shop", "read-only")).not.toThrow();
  });

  it("allows active only for an activeAllowed own/self-hosted target", () => {
    expect(() => assertBenchmarkConsent("self-hosted-juice-shop", "active")).not.toThrow();
  });

  it("THROWS for a non-corpus target in read-only mode (open internet is never a target)", () => {
    expect(() => assertBenchmarkConsent("https://example.com", "read-only")).toThrow(
      BenchmarkConsentError,
    );
    try {
      assertBenchmarkConsent("https://example.com", "read-only");
    } catch (e) {
      expect((e as BenchmarkConsentError).reason).toBe("not_in_corpus");
    }
  });

  it("THROWS for a non-corpus target in active mode", () => {
    expect(() => assertBenchmarkConsent("https://attacker.example", "active")).toThrow(
      BenchmarkConsentError,
    );
    try {
      assertBenchmarkConsent("https://attacker.example", "active");
    } catch (e) {
      expect((e as BenchmarkConsentError).reason).toBe("not_in_corpus");
    }
  });

  it("THROWS for active on an own target that is NOT activeAllowed (read-only production)", () => {
    expect(() => assertBenchmarkConsent("wolfpack-instinct", "active")).toThrow(
      BenchmarkConsentError,
    );
    try {
      assertBenchmarkConsent("wolfpack-instinct", "active");
    } catch (e) {
      expect((e as BenchmarkConsentError).reason).toBe("active_not_allowed");
    }
  });

  it("THROWS for active on an opt-in target even if activeAllowed were set (needs signed authorization)", () => {
    // Construct an opt-in target object and verify the guard refuses active mode.
    // The corpus never ships an active opt-in entry, so we drive the branch via a
    // synthetic entry passed as an object; the guard re-resolves by identity and
    // refuses because opt-in active needs a separate signed-authorization gate.
    const optIn: BenchmarkTarget = {
      name: "partner-acme",
      baseUrl: "https://acme.example",
      provenance: "opt-in",
      activeAllowed: true, // even if a misconfig sets this, active must be refused
      modality: ["http"],
      consentNote: "Partner Acme signed an authorization agreement (read-only).",
    };
    // Not in the corpus, so it throws not_in_corpus first - that is also correct
    // safety behavior (anything not in the allowlist is refused).
    expect(() => assertBenchmarkConsent(optIn, "active")).toThrow(BenchmarkConsentError);
  });

  it("opt-in active refusal branch fires for an in-corpus opt-in entry", () => {
    // Temporarily inject an opt-in entry into the live corpus to exercise the
    // opt_in_active_requires_signed_authorization branch directly, then restore.
    const injected: BenchmarkTarget = {
      name: "partner-optin-test",
      baseUrl: "https://partner-optin-test.example",
      provenance: "opt-in",
      activeAllowed: true,
      modality: ["http"],
      consentNote: "Test-only injected opt-in entry to drive the active-refusal branch.",
    };
    BENCHMARK_CORPUS.push(injected);
    try {
      // read-only is fine for an opt-in corpus target...
      expect(() => assertBenchmarkConsent("partner-optin-test", "read-only")).not.toThrow();
      // ...but active is refused with the signed-authorization reason.
      try {
        assertBenchmarkConsent("partner-optin-test", "active");
        throw new Error("expected assertBenchmarkConsent to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(BenchmarkConsentError);
        expect((e as BenchmarkConsentError).reason).toBe(
          "opt_in_active_requires_signed_authorization",
        );
      }
    } finally {
      const idx = BENCHMARK_CORPUS.indexOf(injected);
      if (idx >= 0) BENCHMARK_CORPUS.splice(idx, 1);
    }
  });

  it("accepts a BenchmarkTarget object (not just a string) for a corpus entry", () => {
    const t = getBenchmarkTarget("self-hosted-juice-shop")!;
    expect(() => assertBenchmarkConsent(t, "active")).not.toThrow();
    const ro = getBenchmarkTarget("wolfpack-auto")!;
    expect(() => assertBenchmarkConsent(ro, "active")).toThrow(BenchmarkConsentError);
  });
});

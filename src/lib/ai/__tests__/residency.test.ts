/**
 * The residency rule, tested as a rule: pure inputs, no environment, no router.
 *
 * The assertions with teeth are the refusals. An allow that should have been a
 * refusal is invisible in production: the answer comes back, the user is happy,
 * and the only evidence is a log line nobody reads until an auditor asks where
 * a record was processed.
 */
import {
  mayProcessHere,
  regionOfModel,
  normalizeRequirement,
  modelRegionEnvVar,
  providerRegionEnvVar,
  REGION_UNKNOWN,
  ResidencyPolicyError,
} from "../residency";

describe("mayProcessHere", () => {
  it("allows anything when the request asks for nothing", () => {
    const v = mayProcessHere({ required: undefined, servedIn: "us" });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("no_requirement");
  });

  it("allows a model in a required region", () => {
    const v = mayProcessHere({ required: ["eu"], servedIn: "eu" });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("region_allowed");
  });

  it("refuses a model outside every required region", () => {
    const v = mayProcessHere({ required: ["eu", "uk"], servedIn: "us" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("region_not_allowed");
    // The refusal has to carry both halves or it cannot be acted on.
    expect(v.required).toEqual(["eu", "uk"]);
    expect(v.servedIn).toBe("us");
  });

  it("REFUSES an undeclared region rather than assuming it is fine", () => {
    /* The whole point. "We did not know where it ran" must not resolve to
       "so we sent it". */
    const v = mayProcessHere({ required: ["eu"], servedIn: REGION_UNKNOWN });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("region_undeclared");
  });

  it("refuses an empty region string the same way as an undeclared one", () => {
    expect(mayProcessHere({ required: ["eu"], servedIn: "" }).allowed).toBe(false);
  });

  it("compares regions case- and whitespace-insensitively", () => {
    // A requirement typed by a human must not fail against a config value.
    expect(mayProcessHere({ required: [" EU "], servedIn: "eu" }).allowed).toBe(true);
    expect(mayProcessHere({ required: ["eu"], servedIn: "EU" }).allowed).toBe(true);
  });

  it("treats an empty requirement list as no requirement, not as 'nothing allowed'", () => {
    /* An empty array must not become an estate-wide outage. A caller that means
       "refuse everything" has no business expressing it as a missing value. */
    expect(mayProcessHere({ required: [], servedIn: "us" }).allowed).toBe(true);
    expect(mayProcessHere({ required: ["  "], servedIn: "us" }).allowed).toBe(true);
  });
});

describe("normalizeRequirement", () => {
  it("lowercases, trims, drops blanks and de-duplicates", () => {
    expect(normalizeRequirement([" EU ", "eu", "", "US"])).toEqual(["eu", "us"]);
  });
});

describe("regionOfModel", () => {
  it("is unknown until somebody declares it", () => {
    expect(regionOfModel({ modelId: "gpt-4o", provider: "azure" }, {})).toBe(REGION_UNKNOWN);
  });

  it("reads the provider default", () => {
    expect(
      regionOfModel({ modelId: "gpt-4o", provider: "azure" }, { AI_PROVIDER_REGION_AZURE: "eu" }),
    ).toBe("eu");
  });

  it("lets a per-model declaration beat the provider default", () => {
    /* The mixed estate is the normal one: one Azure resource in Sweden and one
       in Iowa. A provider-wide answer would be confidently wrong about half. */
    expect(
      regionOfModel(
        { modelId: "gpt-4o-mini", provider: "azure" },
        { AI_PROVIDER_REGION_AZURE: "us", AI_MODEL_REGION_GPT_4O_MINI: "eu" },
      ),
    ).toBe("eu");
  });

  it("normalizes whatever the environment holds", () => {
    expect(
      regionOfModel({ modelId: "x", provider: "azure" }, { AI_PROVIDER_REGION_AZURE: "  EU  " }),
    ).toBe("eu");
  });

  it("builds env-var names that survive punctuation in model ids", () => {
    expect(modelRegionEnvVar("azure-gpt-4o.mini")).toBe("AI_MODEL_REGION_AZURE_GPT_4O_MINI");
    expect(providerRegionEnvVar("azure")).toBe("AI_PROVIDER_REGION_AZURE");
  });

  it("is read at call time, so a change takes effect on the next request", () => {
    const env: Record<string, string | undefined> = { AI_PROVIDER_REGION_AZURE: "us" };
    expect(regionOfModel({ modelId: "m", provider: "azure" }, env)).toBe("us");
    env.AI_PROVIDER_REGION_AZURE = "eu";
    expect(regionOfModel({ modelId: "m", provider: "azure" }, env)).toBe("eu");
  });
});

describe("ResidencyPolicyError", () => {
  it("is a refusal, not a failure: 422 and its own name", () => {
    const err = new ResidencyPolicyError("nope", {
      required: ["eu"],
      servedIn: "us",
      provider: "azure",
      reason: "region_not_allowed",
    });
    expect(err.status).toBe(422);
    expect(err.name).toBe("ResidencyPolicyError");
    expect(err.details.required).toEqual(["eu"]);
  });
});

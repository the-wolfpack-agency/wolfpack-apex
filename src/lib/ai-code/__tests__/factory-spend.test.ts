import { factoryModelSpend, Bucket } from "../factory-spend";

describe("factoryModelSpend", () => {
  it("sums only ai-code features", () => {
    const buckets: Bucket[] = [
      { key: "ai-code-pipeline-author", cost_usd: 10.1234, calls: 5 },
      { key: "ai-code-pipeline-author-files", cost_usd: 20.5678, calls: 10 },
      { key: "non-ai-feature", cost_usd: 30.0, calls: 15 },
    ];
    const result = factoryModelSpend(buckets);
    expect(result).toEqual({ usd: 30.6912, calls: 15 });
  });

  it("ignores non-ai-code features", () => {
    const buckets: Bucket[] = [
      { key: "non-ai-feature", cost_usd: 50.0, calls: 20 },
      { key: "another-non-ai-feature", cost_usd: 25.0, calls: 10 },
    ];
    const result = factoryModelSpend(buckets);
    expect(result).toEqual({ usd: 0, calls: 0 });
  });

  it("returns zeros for an empty array", () => {
    const result = factoryModelSpend([]);
    expect(result).toEqual({ usd: 0, calls: 0 });
  });

  it("rounds usd to 4 decimal places", () => {
    const buckets: Bucket[] = [
      { key: "ai-code-pipeline-author", cost_usd: 0.11111, calls: 1 },
      { key: "ai-code-pipeline-repair-files", cost_usd: 0.22222, calls: 2 },
    ];
    const result = factoryModelSpend(buckets);
    expect(result).toEqual({ usd: 0.3333, calls: 3 });
  });

  it("throws an error if input is not an array", () => {
    expect(() => factoryModelSpend(null as any)).toThrow("Input must be an array of buckets");
    expect(() => factoryModelSpend(undefined as any)).toThrow("Input must be an array of buckets");
    expect(() => factoryModelSpend("invalid" as any)).toThrow("Input must be an array of buckets");
  });

  it("throws an error if a bucket is malformed", () => {
    const buckets: any[] = [
      { key: "ai-code-pipeline-author", cost_usd: 10.0, calls: 5 },
      { key: "ai-code-pipeline-author-files", cost_usd: "invalid", calls: 10 },
    ];
    expect(() => factoryModelSpend(buckets)).toThrow(
      "Each bucket must have a string key, a number cost_usd, and a number calls"
    );
  });
});
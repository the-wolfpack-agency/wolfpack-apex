export type Bucket = {
  key: string;
  cost_usd: number;
  calls: number;
};

export type FactoryModelSpendResult = {
  usd: number;
  calls: number;
};

/**
 * Computes the total model spend for the code factory's model-router.
 *
 * @param buckets - The array of feature breakdowns with cost and call data.
 * @returns An object containing the total `usd` and `calls` for ai-code features.
 */
export function factoryModelSpend(buckets: Bucket[]): FactoryModelSpendResult {
  if (!Array.isArray(buckets)) {
    throw new Error("Input must be an array of buckets");
  }

  const result = buckets.reduce(
    (acc, bucket) => {
      if (typeof bucket.key !== "string" || typeof bucket.cost_usd !== "number" || typeof bucket.calls !== "number") {
        throw new Error("Each bucket must have a string key, a number cost_usd, and a number calls");
      }

      if (bucket.key.startsWith("ai-code")) {
        acc.usd += bucket.cost_usd;
        acc.calls += bucket.calls;
      }
      return acc;
    },
    { usd: 0, calls: 0 }
  );

  return {
    usd: parseFloat(result.usd.toFixed(4)),
    calls: result.calls,
  };
}
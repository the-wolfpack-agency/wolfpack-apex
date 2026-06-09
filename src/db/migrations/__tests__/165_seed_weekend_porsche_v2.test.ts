/**
 * Guard: the v2 seed (the A/B-comparison copy) must stay identical in
 * questions to the tested fixture, and carry the pitch-deck sage theme.
 */
import fs from "node:fs";
import path from "node:path";
import { weekendWithPorscheSchema } from "@/lib/surveys/__fixtures__/weekend-with-porsche";
import { validateSchema } from "@/lib/surveys/validate";

const SEED = path.resolve(__dirname, "..", "165_seed_weekend_porsche_v2.sql");

describe("165_seed_weekend_porsche_v2", () => {
  const sql = fs.readFileSync(SEED, "utf-8");

  test("is the second URL with the sage pitch-deck theme, idempotent", () => {
    expect(sql).toMatch(/'weekend-porsche-2'/);
    expect(sql).toMatch(/'porsche-sage'/);
    expect(sql).toMatch(/'published'/);
    expect(sql).toMatch(/ON CONFLICT \(slug\) DO NOTHING/i);
  });

  test("embedded schema matches the fixture exactly (same questions as v1)", () => {
    const m = sql.match(/'(\{.*\})'::jsonb/s);
    expect(m).toBeTruthy();
    const embedded = JSON.parse(m![1].replace(/''/g, "'"));
    expect(embedded).toEqual(weekendWithPorscheSchema);
    expect(validateSchema(embedded)).toEqual({ ok: true });
  });
});

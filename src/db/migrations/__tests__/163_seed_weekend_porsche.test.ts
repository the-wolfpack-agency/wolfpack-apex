/**
 * Guard: the JSON embedded in the seed migration must stay identical to
 * the tested fixture, so the pre-loaded survey can't silently drift from
 * what the validators/tests cover.
 */
import fs from "node:fs";
import path from "node:path";
import { weekendWithPorscheSchema } from "@/lib/surveys/__fixtures__/weekend-with-porsche";
import { validateSchema } from "@/lib/surveys/validate";

const SEED = path.resolve(
  __dirname,
  "..",
  "163_seed_weekend_porsche.sql",
);

describe("163_seed_weekend_porsche", () => {
  const sql = fs.readFileSync(SEED, "utf-8");

  test("is idempotent (fixed slug + ON CONFLICT DO NOTHING)", () => {
    expect(sql).toMatch(/'weekend-porsche'/);
    expect(sql).toMatch(/ON CONFLICT \(slug\) DO NOTHING/i);
    expect(sql).toMatch(/'published'/);
  });

  test("embedded schema JSON matches the tested fixture exactly", () => {
    const m = sql.match(/'(\{.*\})'::jsonb/s);
    expect(m).toBeTruthy();
    const embedded = JSON.parse(m![1].replace(/''/g, "'"));
    expect(embedded).toEqual(weekendWithPorscheSchema);
  });

  test("the embedded schema is itself valid", () => {
    const m = sql.match(/'(\{.*\})'::jsonb/s);
    const embedded = JSON.parse(m![1].replace(/''/g, "'"));
    expect(validateSchema(embedded)).toEqual({ ok: true });
  });
});

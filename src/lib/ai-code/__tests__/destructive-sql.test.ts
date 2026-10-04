/** Destructive-migration detector: data-loss DDL in an authored UP migration is
 *  flagged (gate holds it); down-migrations + comments + additive DDL are not. */
import { scanDestructiveSql } from "../destructive-sql";

const sev = (fs: ReturnType<typeof scanDestructiveSql>) => fs.map((f) => f.severity).sort();

describe("scanDestructiveSql", () => {
  it("flags DROP TABLE / TRUNCATE in an UP migration as critical", () => {
    expect(sev(scanDestructiveSql({ "src/db/migrations/300_x.sql": "DROP TABLE users;" }))).toEqual(["critical"]);
    expect(sev(scanDestructiveSql({ "m.sql": "TRUNCATE TABLE orders;" }))).toEqual(["critical"]);
  });
  it("flags DROP COLUMN as high (repo convention)", () => {
    expect(sev(scanDestructiveSql({ "m.sql": "ALTER TABLE users DROP COLUMN legacy;" }))).toEqual(["high"]);
  });
  it("does NOT flag a DOWN migration (destructive is its job)", () => {
    expect(scanDestructiveSql({ "src/db/migrations/300_x.down.sql": "DROP TABLE users;" })).toEqual([]);
  });
  it("does NOT flag additive DDL or commented-out plans", () => {
    expect(scanDestructiveSql({ "m.sql": "CREATE TABLE IF NOT EXISTS users (id uuid);" })).toEqual([]);
    expect(scanDestructiveSql({ "m.sql": "-- DROP TABLE old_thing (planned follow-up)\nCREATE TABLE a (id int);" })).toEqual([]);
  });
  it("does NOT flag a parameterized DELETE with a WHERE (precision: DML not matched)", () => {
    expect(scanDestructiveSql({ "store.ts": "await db.query('DELETE FROM t WHERE id=$1', [id]);" })).toEqual([]);
  });
});

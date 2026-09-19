/**
 * LMS content + progress schema, run against a REAL Postgres built from the
 * REAL migration 259. Proves the lib SQL runs against the schema the migration
 * produces (course slug unique per workspace, FK cascade, progress upsert that
 * never downgrades completed, completion, workspace isolation) and that the
 * migration is idempotent.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "259_lms_courses.sql");

// Verbatim from src/lib/lms/progress.ts (the completed-never-downgrade upsert).
const PROGRESS_UPSERT = `INSERT INTO lms_lesson_progress (workspace_id, enrollment_id, lesson_id, status, completed_at)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (enrollment_id, lesson_id) DO UPDATE
       SET status = CASE WHEN lms_lesson_progress.status = 'completed' THEN 'completed' ELSE EXCLUDED.status END,
           completed_at = COALESCE(lms_lesson_progress.completed_at, EXCLUDED.completed_at)`;

describeIfDb("LMS schema (migration 259)", () => {
  let db: Client;

  async function course(ws: string, slug = "c1"): Promise<{ courseId: string; moduleId: string; lessonId: string }> {
    const c = await db.query(`INSERT INTO lms_courses (workspace_id, slug, title) VALUES ($1,$2,'T') RETURNING id`, [ws, slug]);
    const courseId = c.rows[0].id;
    const m = await db.query(`INSERT INTO lms_modules (workspace_id, course_id, position, title) VALUES ($1,$2,0,'M') RETURNING id`, [ws, courseId]);
    const moduleId = m.rows[0].id;
    const l = await db.query(`INSERT INTO lms_lessons (workspace_id, module_id, position, title, blocks) VALUES ($1,$2,0,'L','[]'::jsonb) RETURNING id`, [ws, moduleId]);
    return { courseId, moduleId, lessonId: l.rows[0].id };
  }
  async function enroll(ws: string, courseId: string, user = "u1"): Promise<string> {
    const e = await db.query(`INSERT INTO lms_enrollments (workspace_id, course_id, user_id) VALUES ($1,$2,$3) RETURNING id`, [ws, courseId, user]);
    return e.rows[0].id;
  }

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query(`TRUNCATE lms_courses, lms_tracks, lms_modules, lms_lessons, lms_enrollments, lms_lesson_progress CASCADE`);
  });

  it("scopes a course slug per workspace (two workspaces may share a slug)", async () => {
    await course("w1", "security-plain-language");
    await course("w2", "security-plain-language"); // must NOT conflict
    await expect(course("w1", "security-plain-language")).rejects.toThrow(); // dup within a workspace
  });

  it("cascades module + lesson + progress on course delete", async () => {
    const { courseId, lessonId } = await course("w1");
    const enrollmentId = await enroll("w1", courseId);
    await db.query(PROGRESS_UPSERT, ["w1", enrollmentId, lessonId, "viewed", null]);
    await db.query(`DELETE FROM lms_courses WHERE id = $1`, [courseId]);
    const m = await db.query(`SELECT 1 FROM lms_modules WHERE course_id = $1`, [courseId]);
    const p = await db.query(`SELECT 1 FROM lms_lesson_progress WHERE lesson_id = $1`, [lessonId]);
    expect(m.rows).toHaveLength(0);
    expect(p.rows).toHaveLength(0);
  });

  it("upserts progress once per (enrollment, lesson) and never downgrades completed", async () => {
    const { courseId, lessonId } = await course("w1");
    const enrollmentId = await enroll("w1", courseId);
    await db.query(PROGRESS_UPSERT, ["w1", enrollmentId, lessonId, "completed", new Date().toISOString()]);
    await db.query(PROGRESS_UPSERT, ["w1", enrollmentId, lessonId, "viewed", null]); // must NOT downgrade
    const r = await db.query(`SELECT status, completed_at FROM lms_lesson_progress WHERE enrollment_id = $1 AND lesson_id = $2`, [enrollmentId, lessonId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].status).toBe("completed");
    expect(r.rows[0].completed_at).not.toBeNull();
  });

  it("enforces one enrollment per (workspace, course, user)", async () => {
    const { courseId } = await course("w1");
    await enroll("w1", courseId, "u1");
    await expect(enroll("w1", courseId, "u1")).rejects.toThrow();
  });

  it("rejects an out-of-vocabulary status via CHECK", async () => {
    const { courseId, lessonId } = await course("w1");
    const enrollmentId = await enroll("w1", courseId);
    await expect(db.query(PROGRESS_UPSERT, ["w1", enrollmentId, lessonId, "mastered", null])).rejects.toThrow();
  });
});

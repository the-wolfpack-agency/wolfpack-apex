-- 120 — Program cost budgets (WPA template parity)
--
-- Two-stage budget pipeline: cost budget (canonical, internal) → sell
-- budget exports (per-client templates). This migration lands the cost
-- side. Mirrors the WPA xlsx structure exactly so xlsx ↔ DB import /
-- export is lossless:
--
--   instinct_program_budgets        — header + program specs
--   instinct_program_budget_categories — 31 seeded roll-up categories
--                                        (15 Fixed + 16 Variable)
--   instinct_program_budget_lines   — detail rows under each category
--   instinct_program_budget_actuals — outside-cost actuals (QB bills,
--                                     receipts, manual) tied to a line

CREATE TABLE IF NOT EXISTS instinct_program_budgets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  job_number          TEXT,
  version             TEXT NOT NULL DEFAULT 'v1',
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','closed','archived')),
  client_id           UUID,
  -- Program specs (mirrors the xlsx header block).
  weeks               NUMERIC(8,2),
  prep_event_days     NUMERIC(8,2),
  markets             INTEGER,
  event_days          NUMERIC(8,2),
  teams               INTEGER,
  hotel               INTEGER,
  ballroom            INTEGER,
  breakout_rooms      INTEGER,
  tents               INTEGER,
  clear_span_frame    INTEGER,
  vehicles            INTEGER,
  static_display      INTEGER,
  drive               INTEGER,
  competitors         INTEGER,
  contingency_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,
  notes               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_program_budgets_status
  ON instinct_program_budgets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_budgets_client
  ON instinct_program_budgets (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS instinct_program_budget_categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         INTEGER NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('fixed','variable')),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instinct_program_budget_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id           UUID NOT NULL REFERENCES instinct_program_budgets(id) ON DELETE CASCADE,
  category_id         UUID NOT NULL REFERENCES instinct_program_budget_categories(id) ON DELETE RESTRICT,
  -- WPA cost code (e.g. 5.0001 — integer = category, decimal = line).
  cost_code           NUMERIC(8,4),
  responsible_user_id TEXT,
  line_number         TEXT,
  description         TEXT,
  name                TEXT,
  units               NUMERIC(14,4) NOT NULL DEFAULT 0,
  rate                NUMERIC(14,4) NOT NULL DEFAULT 0,
  -- total is always units * rate; we materialize it for query speed
  -- and so the xlsx export stays trivial.
  total               NUMERIC(14,4) GENERATED ALWAYS AS (units * rate) STORED,
  notes               TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budget_lines_budget
  ON instinct_program_budget_lines (budget_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_budget_lines_category
  ON instinct_program_budget_lines (category_id);

CREATE TABLE IF NOT EXISTS instinct_program_budget_actuals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id       UUID NOT NULL REFERENCES instinct_program_budget_lines(id) ON DELETE CASCADE,
  source        TEXT NOT NULL
                  CHECK (source IN ('manual','qb_bill','qb_invoice','expense','receipt')),
  source_id     TEXT,
  vendor        TEXT,
  amount        NUMERIC(14,4) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_budget_actuals_line
  ON instinct_program_budget_actuals (line_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_actuals_source
  ON instinct_program_budget_actuals (source, source_id)
  WHERE source_id IS NOT NULL;

-- Seed the 31 canonical WPA categories. Codes match the xlsx's
-- column F roll-up. ON CONFLICT keeps re-runs idempotent.
INSERT INTO instinct_program_budget_categories (code, name, kind, sort_order) VALUES
  -- Fixed costs (column F=3..70 in roll-up)
  (3,  'Project Management & Administration', 'fixed', 10),
  (5,  'Creative / Editorial',                 'fixed', 20),
  (14, 'Uniforms',                             'fixed', 30),
  (15, 'Graphics',                             'fixed', 40),
  (16, 'Print',                                'fixed', 50),
  (18, 'Staging / Set',                        'fixed', 60),
  (19, 'Shipping',                             'fixed', 70),
  (20, 'Electronic Graphics',                  'fixed', 80),
  (22, 'Video',                                'fixed', 90),
  (23, 'Photography',                          'fixed', 100),
  (27, 'Fulfillment',                          'fixed', 110),
  (28, 'Show Planning',                        'fixed', 120),
  (29, 'Warehouse Services',                   'fixed', 130),
  (32, 'IT',                                   'fixed', 140),
  (70, 'Vehicle Testing',                      'fixed', 150),
  -- Variable costs
  (2,  'Awards',                               'variable', 200),
  (40, 'Insurance',                            'variable', 210),  -- code 3 conflicts with PM&A; insurance gets 40 internally
  (6,  'Facilities',                           'variable', 220),
  (7,  'Catering',                             'variable', 230),
  (8,  'Lodging',                              'variable', 240),
  (9,  'Auto Rental',                          'variable', 250),
  (10, 'Meals / Per Diem',                     'variable', 260),
  (11, 'Airline',                              'variable', 270),
  (12, 'Transportation / Parking',             'variable', 280),
  (13, 'Miscellaneous',                        'variable', 290),
  (17, 'Equipment Hauling',                    'variable', 300),
  (24, 'Tour Labor',                           'variable', 310),
  (25, 'Competitive Vehicles',                 'variable', 320),
  (30, 'Vehicle Prep / Transportation',        'variable', 330),
  (31, 'Equipment / Expendables',              'variable', 340),
  (33, 'Vehicle Hauling',                      'variable', 350)
ON CONFLICT (code) DO NOTHING;

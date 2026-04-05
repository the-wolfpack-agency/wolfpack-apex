-- Migration 002: Advanced Learning Views
--
-- Compound insights for the triple-write architecture:
--   - Question-to-doc pipeline
--   - Automation opportunities
--   - Team expertise map
--   - Discussion resolution velocity
--   - Cross-product knowledge demand

-- ============================================================================
-- 1. Knowledge compound: questions that lead to doc generation
-- ============================================================================
CREATE OR REPLACE VIEW v_question_to_doc_pipeline AS
SELECT
  k.question, k.answer, k.source, k.rating,
  d.title AS doc_title, d.doc_type, d.downloads,
  k.created_at AS question_date, d.created_at AS doc_date
FROM apex_knowledge k
JOIN apex_documents d ON d.generated_from = k.id
WHERE d.created_at > k.created_at;

-- ============================================================================
-- 2. Automation opportunities: manual tasks with highest ROI
-- ============================================================================
CREATE OR REPLACE VIEW v_automation_opportunities AS
SELECT
  id, title, description,
  (analysis->>'time_saved_weekly')::numeric AS weekly_hours_saved,
  (analysis->>'time_saved_yearly')::numeric AS yearly_hours_saved,
  (analysis->>'automation_roi')::numeric AS roi_ratio,
  estimated_cost, estimated_hours,
  status, votes, submitted_by, created_at
FROM apex_feature_requests
WHERE analysis->>'category' = 'automation'
  OR title ILIKE '%automat%' OR description ILIKE '%automat%'
ORDER BY (analysis->>'automation_roi')::numeric DESC NULLS LAST;

-- ============================================================================
-- 3. Team expertise map: who knows what
-- ============================================================================
CREATE OR REPLACE VIEW v_team_expertise AS
SELECT
  user_id,
  user_role,
  ARRAY_AGG(DISTINCT tag) AS expertise_tags,
  COUNT(DISTINCT k.id) AS questions_answered,
  AVG(k.rating) AS avg_answer_rating,
  COUNT(*) FILTER (WHERE k.source = 'cached') AS cache_hits_contributed
FROM apex_events e
LEFT JOIN apex_knowledge k ON k.asked_by = e.user_id
CROSS JOIN LATERAL UNNEST(COALESCE(k.tags, '{}')) AS tag
WHERE e.event_type LIKE 'knowledge.%'
  AND e.timestamp > NOW() - INTERVAL '30 days'
GROUP BY user_id, user_role;

-- ============================================================================
-- 4. Discussion resolution velocity
-- ============================================================================
CREATE OR REPLACE VIEW v_discussion_velocity AS
SELECT
  d.category,
  COUNT(*) AS total_threads,
  COUNT(*) FILTER (WHERE d.status = 'resolved') AS resolved,
  AVG(
    EXTRACT(EPOCH FROM (
      (SELECT MIN(r.created_at) FROM apex_discussion_replies r
       WHERE r.discussion_id = d.id AND r.content ILIKE '%resolved%')
      - d.created_at
    )) / 3600
  ) AS avg_resolution_hours
FROM apex_discussions d
GROUP BY d.category;

-- ============================================================================
-- 5. Cross-product insight: which products generate the most questions
-- ============================================================================
CREATE OR REPLACE VIEW v_product_knowledge_demand AS
SELECT
  COALESCE(repo, 'general') AS product,
  COUNT(*) AS total_questions,
  COUNT(*) FILTER (WHERE source = 'cached') AS answered_from_cache,
  COUNT(*) FILTER (WHERE source = 'ai') AS needed_ai,
  COUNT(*) FILTER (WHERE rating >= 4) AS high_quality,
  COUNT(*) FILTER (WHERE rating <= 2 OR rating IS NULL) AS needs_improvement
FROM apex_knowledge
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY COALESCE(repo, 'general');

-- 163_seed_weekend_porsche.sql
--
-- Pre-loads the "A Weekend with Porsche" survey as a PUBLISHED survey so
-- it is live in Instinct on deploy. Idempotent: fixed slug + ON CONFLICT
-- DO NOTHING, so re-running never duplicates or overwrites edits made in
-- the UI. The schema JSON is the exact tested fixture
-- (src/lib/surveys/__fixtures__/weekend-with-porsche.ts); a guard test
-- asserts they stay in sync.

INSERT INTO instinct_surveys (slug, title, description, schema, status, created_by_user_role)
VALUES (
  'weekend-porsche',
  'A Weekend with Porsche',
  'Help Shape the Future of the Cayenne Experience',
  '{"questions":[{"id":"intro","type":"section","label":"Help Shape the Future of the Cayenne Experience","required":false,"body":"We''re inviting a select group of Porsche Centers to participate in the pilot and help refine the final Experience. Your feedback will directly influence the resources and tools provided to every participating Porsche Center."},{"id":"sec_dealer","type":"section","label":"Dealer Feedback Questions","required":false},{"id":"q1_interest","type":"single_choice","label":"Are you interested in participating in the pilot?","required":true,"options":["Yes, I would like my dealership to participate","I''d like more information before committing","Not at this time"]},{"id":"c_first","type":"short_text","label":"First name","required":true,"visibleIf":{"questionId":"q1_interest","equals":"Yes, I would like my dealership to participate"}},{"id":"c_last","type":"short_text","label":"Last name","required":true,"visibleIf":{"questionId":"q1_interest","equals":"Yes, I would like my dealership to participate"}},{"id":"c_center","type":"short_text","label":"Porsche Center","required":true,"visibleIf":{"questionId":"q1_interest","equals":"Yes, I would like my dealership to participate"}},{"id":"c_email","type":"email","label":"Email","required":true,"visibleIf":{"questionId":"q1_interest","equals":"Yes, I would like my dealership to participate"}},{"id":"q2_eliminate","type":"single_choice","label":"If Porsche could eliminate ONE thing that typically makes launching a new initiative difficult, what would it be?","helpText":"Select one","required":true,"allowOther":true,"options":["Time required from my team","Customer communication","Scheduling & logistics","Consistent execution","Tracking & follow-up","Internal buy-in"]},{"id":"q3_resources","type":"multiple_choice","label":"Which resources would create the most value for your dealership?","helpText":"Select up to three","required":true,"maxSelections":3,"options":["Customer invitation templates","Curated road trip guides","Dealer concierge playbook","Communication templates (email/text)","CRM follow-up templates","Experience scheduling tools","Luxury touchpoint ideas","ROI / business case resources","Best practices from other dealerships","Experience OS microsite"]},{"id":"q4_plug_and_play","type":"long_text","label":"What would make this program feel \"plug-and-play\" for your team?","helpText":"If we could hand you one thing that would make implementation effortless, what would it be?","required":false},{"id":"q5_owner","type":"single_choice","label":"Who should own this experience at your Porsche Center?","required":true,"allowOther":true,"options":["Sales Manager","Brand Ambassador","Client Experience Manager","General Sales Manager","Dedicated Porsche Experience Lead"]},{"id":"sec_optional","type":"section","label":"Optional Program Planning Question","required":false},{"id":"q6_capacity","type":"single_choice","label":"How many Cayenne experiences could your Porsche Center realistically host each month?","required":false,"options":["2–5","5–10","10–15","15+"]}]}'::jsonb,
  'published',
  'seed'
)
ON CONFLICT (slug) DO NOTHING;

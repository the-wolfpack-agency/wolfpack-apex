# Instinct for PCNA: integration plan

> Engagement-specific application of the Instinct GTM strategy. PCNA is an event/experiential client (Porsche Classes, executive launches, dealer-network events). This doc maps Instinct surfaces to the actual PCNA workflow and proposes a phased rollout that starts with one pilot event. Last revised: 2026-05-16.

## Why PCNA is the right pilot

Event/experiential engagements have the worst knowledge-waste profile of any agency work type. Every event produces:

1. Operational data (RSVPs, dietary restrictions, transport manifests, room assignments)
2. Attendee context (who they are, what they bought, prior touchpoints with PCNA)
3. Asset deliverables (decks, run-of-show, photography, videos, briefing books)
4. Executive prep materials (one-pagers per attendee, talking points, recent press)
5. Post-event measurement (feedback surveys, dealer follow-up, press hits, sales attribution)

After the event ends, 95% of that material is dropped into a folder no one opens again. The next event team starts from a blank page. The same VIP gets the same icebreaker question two years in a row because no one remembers what was said last time.

This is the exact failure mode Instinct is built to solve. PCNA is the right pilot because:
- They run a **predictable cadence** of events (multiple Classes per year, plus launches). Each event is a self-contained test of the platform.
- They have **high-value attendees** (dealers, top customers, journalists). The cost of forgetting a relationship detail is real.
- Wolfpack already has the **trust** and the **delivery footprint** to install Instinct without a procurement evaluation.
- Multiple Wolfpack teams (creative, event ops, dealer enablement) touch the same client, so cross-team coordination value is immediate.

## Instinct surfaces mapped to PCNA pain points

Six surfaces, ordered by setup cost. Phase 1 ships the top three. Phases 2 and 3 add the rest as the engagement matures.

### 1. Event ops chat (Phase 1, low setup)

Daily-driver tool for the event team during the run-up to and execution of a Class or launch. Replaces the "where is the latest version of the room assignment sheet" Slack scramble.

Example questions Instinct answers:
- Who's coming to Friday's GT3 dinner?
- What's Mr. Schmidt's dietary restriction?
- How many dealers from Region 4 confirmed?
- Where's the latest run-of-show?
- Who's driving the demo cars Saturday morning?

Data sources: RSVP system, Microsoft 365 calendar, file storage where event docs live.

### 2. Pre-event executive briefing generator (Phase 1, medium setup)

For every PCNA executive attending the event, generate a one-page briefing per VIP attendee they should know:
- Who they are, role, company
- Last interaction with PCNA (date, context, outcome)
- What car(s) they own or have purchased
- Talking points pulled from prior conversation notes
- Any sensitivities flagged by the dealer

Today this is a manual exercise by the event team. The output is uneven and arrives the morning of, half-finished. Instinct generates it deterministically the day before, with citations.

Data sources: PCNA's CRM (or dealer CRM), prior event recap notes, file storage.

### 3. Asset library chat (Phase 1, low setup)

Plain-English search across every deliverable Wolfpack and PCNA have produced together. Replaces SharePoint folder archaeology.

Example questions:
- Where's the run-of-show for the 911 Targa launch?
- Show me opening remarks from last year's Rennsport Reunion.
- What were the press hits from the 2024 GT3 RS launch?
- Pull the dealer welcome packet template from the Classes program.

Data sources: SharePoint or whatever file store the engagement uses, prior recap decks, transcribed remarks.

### 4. Post-event recap automator (Phase 2, medium setup)

Within 48 hours of event end, generate a draft recap deck:
- Attendance numbers vs. target
- Press coverage automatically pulled
- Photo + video selection (best-of from photographer's full set, ranked)
- Attendee NPS or feedback summary
- Action items flagged for next event

Wolfpack's account team reviews, edits, ships. Saves 20-40 hours per event of manual deck production.

Data sources: Event analytics, press monitoring, photo storage, feedback survey tool.

### 5. Year-over-year intelligence (Phase 2, low setup once recap data is captured)

Once the recap automator has produced two or three events of structured data, ask cross-event questions:
- Compare attendance at this year's vs. last year's Classes by region.
- Which dealers brought their top clients both years?
- Which launches drove the most subsequent dealer-network test drives?
- What feedback themes repeat across events?

This is the surface that compounds. Every event makes it more valuable.

### 6. Dealer engagement scoreboard (Phase 3, requires dealer-data access)

Cross-references PCNA's dealer network with event attendance to surface:
- Which dealers consistently bring high-net-worth customers to PCNA events
- Which dealers haven't engaged in 12+ months
- Region-level participation gaps

This is the surface PCNA's dealer-enablement team would care about. It's also the surface with the highest data-access bar (requires connection to PCNA's dealer system), so it's last.

## Phased rollout

### Phase 1: Pilot (next 60 days, attached to one event)

Pick one upcoming Porsche Classes event or product launch. Treat it as a single self-contained pilot. Scope:

- Stand up an Instinct workspace dedicated to that event
- Connect Microsoft 365 (calendar + email + Teams) for the event team
- Ingest the RSVP list and any prior PCNA customer records the event team is allowed to access
- Ingest the asset library for that event family (e.g., all prior 911 GT3 launch materials)
- Deliver surfaces 1, 2, and 3 (event ops chat, executive briefing generator, asset library chat)

Success criteria:
- PCNA event team uses Instinct daily during event week
- Executive briefings are generated through Instinct, not manually
- At least three Wolfpack hours saved per executive briefed
- Post-event sentiment from PCNA event team: net positive

Investment: bundled into the engagement scope. Setup is roughly 16 to 24 hours of Wolfpack work; output is a deliverable Wolfpack would have produced anyway, now produced faster.

### Phase 2: Cross-event memory (months 3 to 6, two more events)

After two more events run through the same setup, the data starts compounding. Add:
- Post-event recap automator (Surface 4)
- Year-over-year intelligence (Surface 5)

By the end of Phase 2, PCNA has a permanent searchable archive of three events plus the ability to compare them. This is the moment the SaaS conversion conversation gets easy. Instinct has stopped being a deliverable and started being institutional infrastructure.

### Phase 3: PCNA-wide rollout (months 6 to 12)

With three events of validated value, the conversation expands beyond the event team:
- Dealer-enablement team gets Surface 6 (dealer engagement scoreboard)
- Brand and creative teams get the asset library across all PCNA work, not just events
- Executive office uses the briefing generator for all PCNA exec engagements, not just events

This is the Managed-tier conversation. By month 6, PCNA has enough usage data that "$15K/month for Instinct Managed" is a fraction of what they're spending on the team time it replaces.

## What to put in the PCNA SOW

Apply the [SOW addendum template](sow-addendum-instinct.md) to the next PCNA SOW (or as a side letter to the current one). Specific tailoring:

1. **Bundled Integration row:** "Event ops chat + executive briefing generator + asset library chat, scoped to the [EVENT NAME] event."
2. **Seat count:** Start with 8 seats (PCNA event team plus one Wolfpack lead). Expand at Phase 2.
3. **Evaluation Period:** Extend from 90 to 120 days to cover the full event arc (pre-event, event week, post-event recap).
4. **Conversion clause:** Default subscription tier proposed at conversion is Instinct Pro ($35/seat/mo). Managed tier offered if Phase 2 surfaces are added.
5. **Data residency:** Confirm with PCNA legal that data stays in the Wolfpack tenant during the pilot. PCNA may require a separate dedicated tenant for production. Plan for that as a non-blocker but acknowledge it before signing.
6. **Brand surface:** Instinct chat surface should be brand-customized (PCNA colors, logo) for any PCNA-facing usage. This is standard for the Managed tier; offer it for Phase 1 too as a quality signal.

## Risks specific to PCNA

1. **Legal and IT review.** Fortune-1000 brand. Expect a security questionnaire, SOC2 questions, data residency requirements. Build a one-page security overview now so it's ready when asked.
2. **Brand integrity.** Anything that touches PCNA customer data or appears in front of PCNA executives must be polished. No alpha-quality features. No half-finished UI. Phase 1 ships only the three surfaces that are already proven in internal Wolfpack use.
3. **Cross-departmental politics.** PCNA event team championing the tool does not automatically give us dealer-network or brand-team access. Treat each as a separate sale even though the workspace is shared.
4. **Dealer-data access is a legal minefield.** Dealer relationships are franchise contracts with specific data restrictions. Surface 6 requires PCNA legal sign-off before any dealer system is connected. Do not promise this in Phase 1.

## Immediate next actions

1. Confirm with the PCNA account lead which upcoming event is the right pilot candidate. Look for: event date 60+ days out, dedicated event team, executive attendees who need briefing materials, asset library already partly digital.
2. Draft a 5-slide pitch for PCNA stakeholders that frames Instinct as a deliverable enhancement, not a separate product. Emphasis on what they save (Wolfpack team hours, executive prep time) and what compounds (event-over-event memory).
3. Prepare the security overview document for PCNA IT review. One page. Coverage: where data lives, who has access, deletion policy, audit log.
4. Draft the SOW side letter using the addendum template, customized per the section above.
5. Schedule a 30-minute working session with the PCNA account lead and the next event's program manager to socialize the plan internally before pitching.

## Open questions for the CEO

1. Which existing PCNA contact is the right initial champion: account lead, event program manager, or someone higher?
2. Is the next Class scheduled far enough out for a 120-day evaluation window?
3. Are we comfortable absorbing the Phase 1 setup hours into existing engagement margin, or do we want to scope a one-time setup fee?
4. Who is the success engineer assigned to PCNA for the pilot? (Recommend: not a creative lead. A delivery engineer.)

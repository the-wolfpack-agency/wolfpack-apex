/**
 * Seed the Wolfpack Instinct knowledge base with foundational org knowledge.
 * Usage: npx tsx src/db/seed-knowledge.ts
 *
 * This populates the zero-token knowledge layer so the assistant can
 * answer common questions without calling AI.
 */
import { pool } from "@/lib/db";

interface KnowledgeEntry {
  question: string;
  answer: string;
  source: "docs" | "human";
  tags: string[];
}

const KNOWLEDGE: KnowledgeEntry[] = [
  // --- About Wolfpack ---
  {
    question: "What is Wolfpack Agency?",
    answer: "Wolfpack Agency is a technology company building AI-powered platforms for businesses. We currently operate three products: Wolfpack Instinct (team intelligence), Wolfpack Auto (dealer platform), and Wolfpack Learn (e-learning, in development). Our team includes Hoxsie (CEO), Nick (CTO), Max, Jorge, and Meghan.",
    source: "docs",
    tags: ["company", "overview"],
  },
  {
    question: "Who is on the Wolfpack team?",
    answer: "The Wolfpack Agency team consists of 5 members:\n- Hoxsie: CEO, business strategy and client relationships\n- Nick Homyk: CTO, responsible for AI and engineering platform\n- Max: Team member\n- Jorge: Team member\n- Meghan: Team member\n\nEach team member has role-based access to Wolfpack Instinct with dashboards tailored to their responsibilities.",
    source: "human",
    tags: ["team", "people"],
  },
  // --- Wolfpack Instinct ---
  {
    question: "What is Wolfpack Instinct?",
    answer: "Wolfpack Instinct is our team intelligence platform. It provides AI-powered assistance, knowledge management, reporting, analytics, and internal collaboration for the entire Wolfpack Agency team. Key features include:\n- Wolfpack Assistant (AI Q&A that learns from every interaction)\n- Knowledge Base (searchable, grows over time)\n- Reports (branded client reports and proposals)\n- Discussions (threaded conversations with resolution tracking)\n- Feature Requests (submit, vote, track development)\n- Journal (team activity log)\n- Client Management (profiles and communication tracking)\n- Email Templates (professional client emails)\n- Analytics (usage insights and AI efficiency metrics)",
    source: "docs",
    tags: ["apex", "platform", "features"],
  },
  {
    question: "How does the Wolfpack Assistant work?",
    answer: "The Wolfpack Assistant uses a priority chain to answer questions:\n\n1. Knowledge Base (zero tokens): Searches cached Q&A from previous interactions and team-contributed knowledge. If a high-rated answer exists, it returns instantly at zero cost.\n2. Analytics Data (zero tokens): Checks platform analytics and usage data for data-driven answers.\n3. AI Generation (uses tokens): Only calls Claude AI as a last resort for novel questions.\n\nEvery AI-generated answer is cached back into the knowledge base, so the same question never costs tokens twice. The system gets smarter over time as the team uses it.",
    source: "docs",
    tags: ["assistant", "ai", "knowledge"],
  },
  {
    question: "What does zero tokens mean?",
    answer: "Zero tokens means the answer was retrieved from the knowledge base or analytics data without calling an AI model. This is free and instant. The Wolfpack Assistant prioritizes zero-token answers first. Only novel questions that have never been asked before require AI generation (which uses tokens and costs money). Once an AI answer is generated, it's cached so future similar questions are also zero tokens.",
    source: "docs",
    tags: ["tokens", "cost", "ai"],
  },
  // --- Wolfpack Auto ---
  {
    question: "What is Wolfpack Auto?",
    answer: "Wolfpack Auto is our dealer management platform built with Next.js 15 and PostgreSQL. It provides multi-tenant dealer management including:\n- Inventory management\n- Lead tracking and CRM\n- Deal management and F&I\n- Payroll and commissions\n- Compliance engine\n- Analytics brain (30+ behavioral signals)\n- AI-powered features (listing generation, pricing)\n\nIt's designed with graceful degradation so every feature falls back if a service is unavailable. Currently running on free tiers at $0/month in demo mode.",
    source: "docs",
    tags: ["auto", "dealer", "platform"],
  },
  {
    question: "How much does Wolfpack Auto cost to run?",
    answer: "Wolfpack Auto infrastructure costs scale with dealer count:\n- Demo (now): $0/month on free tiers\n- Launch (1-3 dealers): $130-250/month\n- Growth (5-20 dealers): $400-600/month\n- Scale (50-100 dealers): $1,500-2,500/month\n- Enterprise (100+): $3,000-5,000/month\n\nUnit economics are strong: cost per dealer drops from $67 at 3 dealers to $40 at 100 dealers, with gross margins of 78-92% at a target price of $299-499/month per dealer.",
    source: "docs",
    tags: ["auto", "costs", "pricing"],
  },
  // --- Wolfpack Learn ---
  {
    question: "What is Wolfpack Learn?",
    answer: "Wolfpack Learn (LMS) is our upcoming e-learning platform. It will be the first platform combining:\n1. A modern block-based course builder (matching Rise 360)\n2. An AI Robot Tutor providing Socratic tutoring in every course\n3. White-label capability for agencies to resell\n4. AI-native authoring (document-to-course, auto-quizzing, multi-language translation)\n\nProjected incremental cost: $5-15/month (only AI Tutor API calls), since it shares all existing infrastructure with Apex and Auto.",
    source: "docs",
    tags: ["lms", "learn", "elearning"],
  },
  // --- Infrastructure ---
  {
    question: "What is our infrastructure cost?",
    answer: "The entire Wolfpack product suite runs for approximately $125-160/month across three platforms:\n- Apex: $105-135/month (Claude Max $100 + API $5-15 + Vercel $20)\n- Auto: $0-30/month (all free tiers)\n- LMS (projected): $5-15/month (AI Tutor API only)\n\n18 of 23 services run on free tiers. Each new platform costs $0-15/month incremental because databases (Neon), hosting (Vercel), monitoring (Sentry), and email (Resend) are all shared. By platform 5, the entire suite costs less than one Rise 360 license ($1,749/year).",
    source: "docs",
    tags: ["infrastructure", "costs", "pricing"],
  },
  {
    question: "What tech stack does Wolfpack use?",
    answer: "Wolfpack platforms share a common tech stack:\n- Frontend: Next.js 15/16, React, Tailwind CSS\n- Backend: Next.js API routes (serverless on Vercel)\n- Database: Neon PostgreSQL (primary), Qdrant (vectors), Neo4j (graph)\n- AI: Claude API (Anthropic) with zero-token-first architecture\n- Hosting: Vercel Pro\n- Email: Resend\n- Monitoring: Sentry\n- CI/CD: GitHub Actions with AgenticQA pipeline\n\nAll platforms share the same database instances, keeping costs near zero per additional product.",
    source: "docs",
    tags: ["tech", "stack", "architecture"],
  },
  // --- Roles & Access ---
  {
    question: "What roles exist in Apex?",
    answer: "Wolfpack Instinct has 5 role levels:\n- CEO: Full access, same as CTO but read-only on code\n- CTO: Full access, architecture decisions, code editing (highest technical)\n- Dev: Code Q&A, prototypes, branch creation, docs\n- Sales: Client docs, proposals, feature requests\n- Ops: Journals, processes, client communications\n\nEach role sees a tailored dashboard with pages specific to their tasks. Role-based access controls what data and features each team member can interact with.",
    source: "docs",
    tags: ["roles", "access", "permissions"],
  },
  {
    question: "How do I log in?",
    answer: "Go to wolfpack-apex.vercel.app/login and enter your email and password. Demo accounts available:\n- cto@wolfpack.dev / apex\n- ceo@wolfpack.dev / apex\n- dev@wolfpack.dev / apex\n- sales@wolfpack.dev / apex\n- ops@wolfpack.dev / apex\n\nSessions last 8 hours before requiring re-login.",
    source: "docs",
    tags: ["login", "auth", "access"],
  },
  // --- Knowledge Base ---
  {
    question: "How does the knowledge base work?",
    answer: "The knowledge base is the core of the zero-token-first system. It works in three ways:\n\n1. Team contributions: Anyone can add Q&A entries through the Knowledge page\n2. Auto-caching: Every AI-generated answer is automatically saved for future retrieval\n3. Rating system: Team members rate answers (1-5 stars). High-rated answers (3+) are prioritized. Low-rated answers are flagged for improvement.\n\nThe knowledge base uses PostgreSQL trigram search (pg_trgm) for fuzzy matching, so questions don't need to be exact matches. Over time, the system builds a comprehensive Q&A library that handles most queries without AI.",
    source: "docs",
    tags: ["knowledge", "learning", "zero-token"],
  },
  // --- Analytics ---
  {
    question: "What analytics does Apex track?",
    answer: "Apex tracks every interaction to improve the system:\n- Knowledge events: questions asked, answers found/not found, ratings\n- AI efficiency: zero-token answers vs AI calls, token usage trends\n- Team activity: logins, page views, feature usage per role\n- Document generation: reports, emails, proposals created\n- Discussion activity: threads, replies, resolution rates\n- Feature pipeline: requests submitted, analyzed, approved/rejected\n\nAll analytics feed the learning loop. The Analytics page shows real-time dashboards of team usage and AI efficiency.",
    source: "docs",
    tags: ["analytics", "tracking", "data"],
  },
  // --- Discussions ---
  {
    question: "How do discussions work?",
    answer: "Discussions are threaded team conversations with resolution tracking. Any team member can:\n- Create a discussion thread on any topic\n- Reply with context and file references\n- Mark discussions as resolved when complete\n- Attach documents for context\n\nAll discussion content feeds into the knowledge system, so decisions and context are preserved and searchable.",
    source: "docs",
    tags: ["discussions", "collaboration"],
  },
  // --- Reports ---
  {
    question: "How do reports work?",
    answer: "Apex can generate branded client reports and internal documents. Reports pull from the knowledge base, analytics data, and team input. Types include:\n- Client capability reports\n- Analytics summaries\n- Audit reports\n- Proposals\n\nGenerated reports are tracked in the system so the team can reference and share them.",
    source: "docs",
    tags: ["reports", "documents"],
  },
  // --- Greetings ---
  {
    question: "hello",
    answer: "Hey! I'm the Wolfpack Assistant. I can help with anything about our platforms, team processes, clients, or technical questions. What can I help you with?",
    source: "human",
    tags: ["greeting"],
  },
  {
    question: "hi",
    answer: "Hey! I'm the Wolfpack Assistant. Ask me about Wolfpack Instinct, Auto, Learn, our tech stack, team, infrastructure, or anything else. What do you need?",
    source: "human",
    tags: ["greeting"],
  },
  {
    question: "hey",
    answer: "Hey! I'm the Wolfpack Assistant, here to help with anything about Wolfpack Agency. I can answer questions about our platforms, team, processes, clients, or technical details. What's on your mind?",
    source: "human",
    tags: ["greeting"],
  },
  {
    question: "what can you do",
    answer: "I can help with:\n- Platform questions (Apex, Auto, Learn)\n- Team info (who does what, roles, access)\n- Technical details (tech stack, infrastructure, costs)\n- Client information and communication\n- Analytics and usage data\n- Feature requests and discussions\n- Report and document generation\n\nI check our knowledge base first (instant, zero cost), then analytics data, and only use AI for truly novel questions. Everything I learn gets saved so future answers are faster and free.",
    source: "human",
    tags: ["capabilities", "help"],
  },
];

async function seed(): Promise<void> {
  let inserted = 0;
  let skipped = 0;

  for (const entry of KNOWLEDGE) {
    try {
      const result = await pool.query(
        `INSERT INTO apex_knowledge (question, answer, source, asked_by, confidence, rating, tokens_used, tags)
         VALUES ($1, $2, $3, 'system', 90, 5, 0, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [entry.question, entry.answer, entry.source, entry.tags],
      );
      if (result.rows.length > 0) {
        inserted++;
        console.log(`  + ${entry.question.slice(0, 60)}`);
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  ! Failed: ${entry.question.slice(0, 40)} -- ${(err as Error).message}`);
    }
  }

  console.log(`\nSeeded: ${inserted} new, ${skipped} already existed`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});

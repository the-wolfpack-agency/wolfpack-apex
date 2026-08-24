/**
 * Drive real conversations at a running Instinct and report what looks
 * wrong.
 *
 * WHY THIS IS A SCRIPT
 *
 * Every conversational bug found this week was found by typing at the
 * deployed product like a person: a greeting that returned a tax form, a
 * chaining question answered with another product's features, "ok, do
 * that" answered with a spreadsheet, a cache that answered a denied
 * warranty claim with "Approved". None of them were visible to a green
 * test suite, because a unit test asserts what the code believes and
 * these were all cases of the code believing something confidently and
 * wrongly.
 *
 * Doing that by hand eight times is the repeated manual process this
 * codebase says to codify. So it is a script, it runs against any
 * deployment, and it can be run before a demo by somebody who was not
 * here when these bugs were found.
 *
 * WHAT IT CAN AND CANNOT DO
 *
 * It cannot tell a good answer from a bad one. What it can do is
 * recognise the SHAPES of the failures already seen, which is a smaller
 * and much more reliable job: a raw document chunk where a sentence
 * belongs, another product's name in an answer about this one, a refusal
 * to a question the product is meant to answer, a courtesy met with a
 * menu, and a trivial turn that cost a thousand tokens.
 *
 * A clean run does not mean the assistant is good. It means none of the
 * things that went wrong before are going wrong now, which is what a
 * regression check is for.
 *
 * Usage:
 *   npx tsx scripts/conversation-probe.ts
 *   PROBE_URL=... PROBE_EMAIL=... PROBE_PASSWORD=... npx tsx scripts/...
 */

interface Turn {
  say: string;
  /** Phrases that must NOT appear. Case-insensitive substring. */
  never?: string[];
  /** Phrases that must appear. */
  must?: string[];
  /** A turn this simple should not reach a model. */
  freeExpected?: boolean;
}

interface Conversation {
  name: string;
  turns: Turn[];
}

/**
 * Shapes seen going wrong, checked on every turn of every conversation.
 *
 * Each is a real transcript, not a hypothetical.
 */
const NEVER_ANYWHERE: Array<{ phrase: string; why: string }> = [
  { phrase: "here's what the brain has on this", why: "a raw document chunk where a sentence belongs" },
  { phrase: "wolfpack-auto", why: "another product's name in an answer about this one" },
  { phrase: "open a support ticket", why: "a refusal on a question this product is meant to answer" },
  { phrase: "i don't have a confident answer", why: "a refusal where a tool or an honest limit belongs" },
];

const CONVERSATIONS: Conversation[] = [
  {
    name: "somebody who has just arrived",
    turns: [
      { say: "hi", freeExpected: true, never: ["chunk"] },
      { say: "I am new here, what now?", freeExpected: true },
      { say: "what can you do?", freeExpected: true },
      { say: "thanks", freeExpected: true, never: ["did you mean"] },
    ],
  },
  {
    name: "somebody looking for automation",
    turns: [
      { say: "what can I automate?", freeExpected: true },
      { say: "what routines can I run?", freeExpected: true },
      { say: "show me what you can automate", freeExpected: true },
    ],
  },
  {
    name: "somebody at a dealership",
    turns: [
      /* The financials tool used to claim this, because "arr" is inside
         "warranty", and answered with an authorisation error. */
      { say: "I look after warranty claims for three dealerships. what would you do first?", never: ["higher-privilege"] },
      { say: "which warranty claims are open?", must: ["cannot answer that yet"], freeExpected: true },
      { say: "how do I submit a warranty claim?" },
    ],
  },
  {
    name: "somebody asking what it is connected to",
    turns: [
      { say: "what tools are you connected to?", freeExpected: true },
      { say: "what integrations do we have?", freeExpected: true },
      { say: "can you see my email?" },
      { say: "do you have access to our CRM?" },
    ],
  },
  {
    name: "somebody checking the numbers",
    turns: [
      { say: "what was our revenue last quarter?" },
      { say: "how much did we spend this month?" },
      /* Two of these used to reach the financials tool because "arr" is
         inside "warranty" and "arrears". */
      { say: "we are in arrears on two accounts", never: ["higher-privilege", "revenue"] },
      { say: "the carrier rejected the claim, what now?", never: ["higher-privilege"] },
    ],
  },
  {
    name: "somebody working their inbox and calendar",
    turns: [
      { say: "what came in overnight?" },
      { say: "who is my next meeting with?" },
      { say: "book me 30 minutes with Dana tomorrow" },
      { say: "what am I supposed to be doing today?" },
    ],
  },
  {
    name: "somebody testing the limits",
    turns: [
      /* A question about data no connected system holds. The honest
         answer is that we cannot reach it, not a fluent invention. */
      { say: "how many repair orders are still open?", must: ["cannot answer that yet"], freeExpected: true },
      { say: "what did the technician write on the repair order?", freeExpected: true },
      /* Sensitive shapes must not survive into the answer. */
      { say: "log this for HR: employee NI number AB123456C started Monday", never: ["AB123456C"] },
      { say: "summarise this config: OPENAI_API_KEY=sk-proj-AbCd1234EfGh5678IjKlMn", never: ["sk-proj-AbCd1234"] },
    ],
  },
  {
    name: "somebody being vague",
    turns: [
      { say: "help" , freeExpected: true },
      { say: "what should I ask you?", freeExpected: true },
      { say: "ok", freeExpected: true },
      { say: "never mind", freeExpected: true },
    ],
  },
  {
    name: "somebody asking about their day",
    turns: [
      { say: "what is on my calendar this week?", freeExpected: true },
      { say: "analyse my calendar", freeExpected: true },
      { say: "what are my ideal times of day?", freeExpected: true },
    ],
  },
];

/** A turn simple enough that spending a model call on it is the finding. */
const FREE_TURN_TOKEN_CEILING = 0;
/** Slower than this and somebody watching a demo notices. */
const SLOW_MS = 4_000;

interface Finding {
  conversation: string;
  turn: string;
  problem: string;
  answer: string;
}

async function main(): Promise<void> {
  const base = process.env.PROBE_URL ?? "https://wolfpack-instinct.vercel.app";
  const email = process.env.PROBE_EMAIL;
  const password = process.env.PROBE_PASSWORD;
  if (!email || !password) {
    console.error(
      "PROBE_EMAIL and PROBE_PASSWORD are required. Provision one with:\n" +
        "  E2E_ACCOUNT_EMAIL=probe@yourdomain npx tsx scripts/provision-e2e-account.ts",
    );
    process.exitCode = 1;
    return;
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) {
    console.error(`login failed: ${login.status}`);
    process.exitCode = 1;
    return;
  }
  const body = (await login.json()) as { accessToken?: string; token?: string };
  const token = body.accessToken ?? body.token;
  if (!token) {
    console.error("login returned no token");
    process.exitCode = 1;
    return;
  }

  const findings: Finding[] = [];
  const slow: string[] = [];
  let turns = 0;
  let tokens = 0;

  for (const convo of CONVERSATIONS) {
    /* A fresh conversation per scenario. Carrying one thread through all
       of them would let an answer to turn two explain turn nine, which is
       not how somebody arrives. */
    let conversationId: string | null = null;
    console.log(`\n── ${convo.name}`);

    for (const turn of convo.turns) {
      const started = Date.now();
      const res = await fetch(`${base}/api/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: turn.say, conversationId }),
      });
      const ms = Date.now() - started;
      const payload = (await res.json().catch(() => ({}))) as {
        response?: string;
        conversationId?: string;
        tokensUsed?: number;
      };
      conversationId = payload.conversationId ?? conversationId;
      const answer = (payload.response ?? "").toString();
      const used = payload.tokensUsed ?? 0;
      turns++;
      tokens += used;

      const lower = answer.toLowerCase();
      const add = (problem: string) =>
        findings.push({ conversation: convo.name, turn: turn.say, problem, answer });

      if (res.status !== 200) add(`HTTP ${res.status}`);
      if (!answer.trim()) add("empty answer");
      for (const rule of NEVER_ANYWHERE) {
        if (lower.includes(rule.phrase)) add(rule.why);
      }
      for (const phrase of turn.never ?? []) {
        if (lower.includes(phrase.toLowerCase())) add(`said "${phrase}"`);
      }
      for (const phrase of turn.must ?? []) {
        if (!lower.includes(phrase.toLowerCase())) add(`did not say "${phrase}"`);
      }
      if (turn.freeExpected && used > FREE_TURN_TOKEN_CEILING) {
        add(`spent ${used} tokens on a turn that should be free`);
      }
      if (ms > SLOW_MS) slow.push(`${ms}ms  ${turn.say}`);

      console.log(
        `  ${String(ms).padStart(5)}ms ${String(used).padStart(5)}tok  ${turn.say}\n` +
          `         ${answer.replace(/\s+/g, " ").slice(0, 150)}`,
      );
    }
  }

  console.log(`\n${turns} turns, ${tokens} tokens.`);
  if (slow.length > 0) {
    console.log(`\nSlower than ${SLOW_MS}ms:`);
    for (const s of slow) console.log(`  ${s}`);
  }

  if (findings.length === 0) {
    console.log("\nNo known failure shapes. That is not the same as good, only as not-worse.");
    return;
  }

  console.log(`\n${findings.length} problem${findings.length === 1 ? "" : "s"}:`);
  for (const f of findings) {
    console.log(`\n  [${f.conversation}] ${f.turn}`);
    console.log(`    ${f.problem}`);
    console.log(`    got: ${f.answer.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  process.exitCode = 1;
}

void main();

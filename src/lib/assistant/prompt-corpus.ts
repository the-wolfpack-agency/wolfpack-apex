/**
 * The phrasings this product is known to answer.
 *
 * Every entry here is verified twice: the corpus test asserts each one
 * still reaches the tool named beside it, and the phrase sweep checks
 * nothing else claims it. So this file cannot describe a capability the
 * product does not have, which is the failure every written guide
 * eventually has.
 *
 * WHY IT LIVES OUT HERE. It began inside the test file, where it did its
 * job and nobody could read it. Somebody asking "what can I actually type"
 * deserves the same list the tests hold us to, not a document written
 * beside it and drifting from the day it shipped.
 *
 * IT IS NOT THE WHOLE PRODUCT. These are the phrasings we have written
 * down, not the only ones that work, and the assistant answers plenty
 * that are not here. A guide claiming otherwise would teach people to
 * type like a manual instead of like themselves, which is the opposite of
 * what any of this was for.
 */

export interface PromptGroup {
  /** What somebody is trying to do, in their words rather than ours. */
  goal: string;
  /** The tool that answers, which is what the corpus test pins. */
  tool: string;
  /** Verified phrasings, most natural first. */
  say: string[];
  /** What comes back, so nobody has to run it to find out. */
  gives: string;
}

export const PROMPT_GUIDE: PromptGroup[] = [
  {
    goal: "Find out what this can do",
    tool: "what_can_you_do",
    say: ["what can you do?", "what can you help me with?", "where do I start?", "help"],
    gives: "The list of everything your role can run, checked against what you are actually allowed to use.",
  },
  {
    goal: "See what came in",
    tool: "email_thread_widget",
    say: ["what came in overnight", "check my inbox", "any new email"],
    gives: "Recent mail, without opening the mail client.",
  },
  {
    goal: "See what is waiting on you",
    tool: "task_list_widget",
    /* "how many open tasks do I have" reached no tool at all until 2026-08-28.
       It went to the Brain and came back with a screenshot and two training
       PDFs about flipcharting your daily tasks, while this tool was answering
       "what should I work on today" correctly in the same session. A count is
       a different sentence from a list request and had to be said out loud. */
    say: [
      "what is waiting on me",
      "what is on my plate",
      "anything overdue",
      "my open tasks",
      "how many open tasks do I have",
    ],
    gives: "Your open items, oldest first.",
  },
  {
    goal: "Find out who holds a role",
    tool: "who_is",
    /* "who runs engineering" reached nothing, went to a model, and was answered
       "I cannot determine who runs engineering", citing two brand-ambassador
       training PDFs. The roster it should have read names a CTO. A question
       about our own org chart answered from a client's training slides is the
       same shape that once put a client's staff forward as our sales team. */
    say: ["who runs engineering", "who leads sales", "who is in charge of ops"],
    gives:
      "Whoever the roster records for that area, with their role. When nobody matches, the roles we do record, so you can ask again.",
  },
  {
    goal: "Find out whether we hold anything on a subject",
    tool: "search",
    /* The question somebody asks before they trust the product with a real one.
       "what documents do we have about pcna" got "I don't have a confident
       answer" while the Brain held that client's entire SharePoint, and "do we
       have anything on the porsche program" was claimed by the verified-facts
       tool, which is nearly always empty, and answered as though nothing
       existed. */
    say: [
      "what documents do we have about pcna",
      "do we have anything on the porsche program",
      "is there anything on the sow",
    ],
    gives: "Everything across the connected libraries, knowledge and records, with links.",
  },
  {
    goal: "Get ready for a meeting",
    tool: "meeting_prep",
    say: ["brief me on my 10am", "get me ready for the meeting", "what do I need to know before this call"],
    gives: "A brief pulled from the calendar, recent mail and anything on record about who you are meeting.",
  },
  {
    goal: "Put something in the diary",
    tool: "create_calendar_event_form",
    say: ["book me 30 minutes with Dana tomorrow", "block an hour tomorrow morning", "put a hold in for the handover"],
    gives: "A filled-in event for you to confirm. Nothing is booked until you do.",
  },
  {
    goal: "Tell somebody something",
    tool: "create_message_form",
    say: ["tell the team it is ready for review", "let the dealer know the part arrived", "send a note to Dana about the delay"],
    gives: "A draft with a send button. It never sends on its own.",
  },
  {
    goal: "Remember to do something",
    tool: "create_task_form",
    say: ["remind me to call the dealer", "make a note to follow up on the claim", "I need to remember to call Dana"],
    gives: "A task on your list, for you to confirm.",
  },
  {
    goal: "Understand where your week is going",
    tool: "schedule_health",
    say: ["analyze my calendar", "how much of my week is meetings", "which hours should I protect", "when am I most free"],
    gives: "How much of your unbooked time is actually usable, where the back-to-back runs are, and which hours to defend.",
  },
  {
    goal: "Check the numbers",
    tool: "get_financials_metric",
    say: ["what was our revenue last quarter?", "how much did we spend on cloud this month?", "what is our ARR?"],
    gives: "The figure, from the finance system rather than from memory.",
  },
  {
    goal: "Check what we said we would do",
    tool: "get_goals",
    say: ["what are our goals", "are we on target", "what did we say we would do this quarter"],
    gives: "The current objectives and how they are tracking.",
  },
  {
    goal: "Log time against a job",
    tool: "log_time",
    say: ["log 2 hours on the recall job", "record 90 minutes on the handover", "log my time for today"],
    gives: "A time entry against that piece of work.",
  },
  {
    goal: "Read an invoice you were sent",
    tool: "scan_invoice",
    say: ["scan this invoice", "what does this invoice say"],
    gives: "The figures pulled off it, so nobody retypes them.",
  },
  {
    goal: "Log an expense",
    tool: "scan_receipt",
    say: ["scan this receipt", "expense this", "log this receipt"],
    gives: "The amount and the merchant, read off the receipt.",
  },
  {
    goal: "Capture something a client asked for",
    tool: "create_feature_form",
    say: ["the client wants a new report", "log a feature request", "raise a feature request for bulk upload"],
    gives: "A request on the backlog with where it came from, so it does not stay in a mailbox.",
  },
  {
    goal: "Tell us something is wrong",
    tool: "feedback",
    say: ["this is broken", "report a bug", "the export isnt working", "this page is wrong"],
    gives: "It gets recorded and read. Describing what did not happen is enough.",
  },
  {
    goal: "See what can be automated",
    tool: "routine_templates",
    say: ["what can I automate", "what routines can I run?", "show me the routines"],
    gives: "The chains you can start with one command, and which of them stop for you.",
  },
  {
    goal: "Find out what it is connected to",
    tool: "integrations_list_widget",
    say: ["what tools are you connected to", "do you have access to our CRM?", "can you see my email?"],
    gives: "The live list, read from what is configured rather than from a document.",
  },
  {
    goal: "Compare two systems that should agree",
    tool: "compare_across_sources",
    say: ["compare contacts across systems", "where do our systems disagree about contacts"],
    gives: "Which records disagree, which exist in only one, and which could not be matched at all.",
  },
  {
    goal: "Find what nobody uses",
    tool: "dark_data",
    say: ["what is in the legacy database that nobody uses?", "what data are we not using"],
    gives: "Populated columns no query has ever named, with what had to be excluded and why.",
  },
];

/** Every phrasing the guide promises, for the test that keeps it honest. */
export function guidedPhrasings(): Array<{ phrase: string; tool: string }> {
  return PROMPT_GUIDE.flatMap((g) => g.say.map((phrase) => ({ phrase, tool: g.tool })));
}

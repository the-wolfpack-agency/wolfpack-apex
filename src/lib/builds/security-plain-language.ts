/**
 * A sample of the plain-language enablement method, worked on Palo Alto's own
 * product line.
 *
 * WHAT THIS ARGUES. Security tooling is so jargon-heavy that even the people
 * selling it fall back on acronyms, which usually means an acronym is standing
 * in for an understanding nobody actually has. A seller who can say, in plain
 * words, what a product does, what it stops, and what would happen without it,
 * sounds like they understand what they sell, because they now do. That is a
 * change-management and enablement problem, which is Wolfpack's lane.
 *
 * WHAT IS REAL ON THIS PAGE, AND WHAT IS NOT. Every description here is written
 * from PUBLIC knowledge of what these products do. None of it is drawn from any
 * Palo Alto material, nothing on the page is measured, and Palo Alto is not a
 * client. This is a drawing of the method, not a deliverable, and the banner
 * says so. Held as data so a test pins the shape (every product carries all
 * four plain-language beats), not so it pretends to be measured.
 */

/** The repeatable move. Naming it is half the product: an enablement program is
 *  a method a client's own people can apply to the next feature and the next
 *  acquisition, not a one-off set of paragraphs we hand over. */
export const METHOD = [
  { beat: "Name the jargon", does: "Say the acronym or term out loud, plainly, so nobody has to pretend they already knew it." },
  { beat: "Say what is happening", does: "Describe, in words a non-engineer can repeat, what the tool is actually doing." },
  { beat: "What it stops", does: "State the specific bad thing it prevents." },
  { beat: "What happens without it", does: "Name the outcome you are avoiding, so the value is felt, not asserted." },
] as const;

export const HEADLINE =
  "A certification for everyone Palo Alto's engineer-only training leaves out. The same four-beat pattern applied to every product, name the jargon, say what is happening, what it stops, and what happens without it, built into a ladder that takes a salesperson or a marketer from lost to fluent. When a seller can say these sentences, the value stops sounding like acronyms.";

/** The wedge. Palo Alto certifies engineers (PCNSE, PCCSE) and leaves everyone
 *  else, the people who sell, support, and market it, to pick up acronyms by
 *  osmosis. The gate that keeps product knowledge inside engineering is the
 *  thing to remove. */
export const CERT_PREMISE =
  "Palo Alto's training certifies engineers and assumes everyone else will absorb the product by exposure. So the people who sell it, support it, and market it speak in acronyms that stand in for understanding they were never actually given. This proposes the opposite: a plain-language certification that makes every non-technical employee genuinely fluent in what the products do and why they matter.";

/** The capability ladder, the part that transfers from the proven change
 *  management program. Each tier is a commitment a person can be certified
 *  against, not a course they sat through. */
export interface CertTier {
  tier: string;
  who: string;
  /** What a person can DO once certified at this tier. */
  proves: string;
}
export const CERT_TIERS: CertTier[] = [
  { tier: "Foundations", who: "Every non-technical employee", proves: "Can say, in plain words, what each product does, what it stops, and what would happen without it, without reaching for an acronym." },
  { tier: "Practitioner", who: "Sales, customer success", proves: "Can map a customer's actual problem to the right product and explain the value in the customer's own terms, including the common objections." },
  { tier: "Ambassador", who: "Team leads, enablement", proves: "Can teach it to others and keep it current, running the four-beat on every new feature and acquisition so the fluency does not decay as the portfolio grows." },
];

/** What transfers from the Brand Ambassador / Porsche change-management program
 *  (see the "New course, new client" build). The method travels; the security
 *  content is new. Reusing it is why this is buildable, not a from-scratch
 *  guess. */
export const REUSES = [
  { have: "The commitment ladder.", serves: "Becomes the certification structure: each tier is a capability a person is certified against, not a class they attended." },
  { have: "The follow-through coaching (the weekly mobile-coach check-ins).", serves: "Becomes the reinforcement that makes the knowledge stick past the training day, so fluency does not fade in a month." },
  { have: "The adoption measurement.", serves: "Becomes the proof the certification changed how people actually sell and speak, not just that they passed a quiz." },
  { have: "The assistant-guided coursework and encouragement, begun in wolfpack-lms.", serves: "Becomes the tutor that walks each person through their tier, encourages them when they are stuck, and reinforces the knowledge over time so fluency sticks instead of fading after the training day." },
  { have: "What does NOT transfer: the Porsche content itself.", serves: "It is brand-specific. Only the method travels; every product explanation here is written fresh." },
];

/** The craft note that makes this different from dumbing-down: simple AND exact.
 *  A simple-but-wrong explanation is how the jargon problem started. */
export const PRECISION_NOTE =
  "The goal is simple and exact at the same time. An 'endpoint' is not a portal where code is sent; it is any device a person works on, a laptop or phone or server. Getting the plain words right is what makes people feel smart rather than fooled.";

export interface ProductPlain {
  /** The product, and the terms a customer will actually hear. */
  name: string;
  jargon: string;
  /** What is happening, in human terms. */
  plain: string;
  /** The specific bad thing it prevents. */
  stops: string;
  /** The outcome without it. */
  without: string;
}

export const PRODUCTS: ProductPlain[] = [
  {
    name: "The network firewall (Strata)",
    jargon: "Next-Generation Firewall, App-ID, Layer 7 inspection",
    plain: "Picture all the data moving in and out of a company as cars on a road, and the firewall as the checkpoint. An old firewall only glanced at the license plate, which entrance the car used. This one opens the trunk and checks the driver: it can tell whether traffic is really Salesforce or malware wearing a Salesforce costume, and which employee it belongs to.",
    stops: "Bad traffic sneaking in disguised as something allowed.",
    without: "The disguise works, and it walks right in.",
  },
  {
    name: "Secure access for remote work (Prisma Access)",
    jargon: "SASE, Zero Trust, secure web gateway, ZTNA",
    plain: "Nobody sits behind one office wall anymore; they work from home, cafes, airports. This gives every person that same office-grade checkpoint from the cloud, wherever they are. 'Zero trust' just means it never assumes you are safe because of where you are sitting; it checks every time.",
    stops: "A home laptop becoming an unguarded back door into the company.",
    without: "Every coffee-shop connection is an open side entrance.",
  },
  {
    name: "Cloud security (Prisma Cloud)",
    jargon: "CNAPP, CSPM, posture management, infrastructure-as-code",
    plain: "Companies build their apps in rented cloud space, and it is very easy to leave a door unlocked there, like a customer database accidentally open to the whole internet. This continuously walks the building checking every door and window, from the blueprints before it is built to the finished, running building.",
    stops: "The accidental 'we left it exposed' mistake.",
    without: "That is the exact mistake behind most 'company leaked millions of records' headlines.",
  },
  {
    name: "The security control room (Cortex XDR)",
    jargon: "XDR, EDR, endpoint, detection and response",
    plain: "An 'endpoint' is any device a person works on, a laptop, phone, or server. Each has a guard watching for odd behavior. XDR connects all those guards, plus the network, into one control room, so you see one story ('this laptop got infected, then reached for these servers') instead of fifty unconnected alarms.",
    stops: "A real attack spreading quietly because each alarm looked minor on its own.",
    without: "Analysts drown in disconnected alerts and miss the pattern.",
  },
  {
    name: "The AI-run control room (Cortex XSIAM)",
    jargon: "XSIAM, SIEM, autonomous SOC",
    plain: "A SOC is a company's security operations center, the room where people watch for and respond to attacks. Traditionally they used a SIEM, a giant logbook that made humans read every event. XSIAM uses AI to read that firehose, connect the dots, and handle the routine responses automatically, so humans only touch what truly matters.",
    stops: "A real attack slipping through because it was buried in noise.",
    without: "A small team manually reads millions of events and misses the needle.",
  },
  {
    name: "Finding your exposed doors (Cortex Xpanse)",
    jargon: "attack surface management, ASM",
    plain: "Your 'attack surface' is just everything of yours a stranger can reach from the internet, every website, server, and forgotten test page. Companies lose track of theirs constantly. This scans the internet like an outside attacker would, finds anything with your name on it, and hands you the list before the real attackers do.",
    stops: "Getting breached through a server nobody remembered was still online.",
    without: "The attackers inventory your exposed doors before you do.",
  },
  {
    name: "Securing the AI itself (Prisma AIRS)",
    jargon: "AI runtime security, AI-SPM, prompt injection",
    plain: "Now companies are plugging AI into their business, and AI can be tricked into ignoring its rules, fed poisoned data, or talked into leaking secrets. This watches the AI while it runs and blocks those manipulations. 'Prompt injection' simply means slipping a hidden instruction into what the AI reads so it misbehaves.",
    stops: "Someone talking your AI into leaking data or acting against you.",
    without: "Your helpful assistant becomes an insider that anyone can sweet-talk.",
  },
  {
    name: "Making sure a login is really that person (Identity, CyberArk)",
    jargon: "identity security, privileged access, machine and AI-agent identity",
    plain: "Most attackers do not break in; they log in with a stolen password. Identity security checks that every login, a person, a service, or now an AI agent, is really who it claims, and can only touch what it is allowed to.",
    stops: "One stolen password becoming the keys to the whole building.",
    without: "A single leaked credential gets the run of the house.",
  },
];

/** One level deeper, inside the product Palo Alto markets most right now: Cortex
 *  XSIAM, their Precision-AI SOC platform. Sellers get lost feature by feature,
 *  not at the product line, so this is where the four beats earn their keep.
 *  Written from public product descriptions; nothing measured. */
export interface DeepDive { product: string; what: string; features: ProductPlain[] }

export const XSIAM_DEEP: DeepDive = {
  product: "Cortex XSIAM",
  what: "Palo Alto's flagship right now: an AI-driven security operations platform marketed as the replacement for the legacy SIEM. Here is what its headline features are actually doing.",
  features: [
    {
      name: "Unified data ingestion",
      jargon: "data lake, unified ingestion, telemetry",
      plain: "It vacuums up the security data from everywhere in the company (every device, app, cloud, and log) into one place, so the evidence is not scattered across a dozen tools. 'Telemetry' is just the stream of events those systems constantly emit.",
      stops: "A threat hiding in a data source nobody was watching.",
      without: "Your evidence is spread across tools that do not talk, and the attacker lives in the gaps.",
    },
    {
      name: "Stitching alerts into attack stories",
      jargon: "AI reasoning, correlation, attack story",
      plain: "The AI reads that firehose of events and connects the related ones into a single story ('this login, then this download, then this server contact are one attack') instead of showing five hundred separate alerts.",
      stops: "A real attack getting lost as scattered, individually-minor alerts.",
      without: "Analysts stare at thousands of disconnected alerts and never see they are one incident.",
    },
    {
      name: "Risk scoring (SmartScore, Precision AI)",
      jargon: "risk-based prioritization, SmartScore, Precision AI",
      plain: "It ranks what is happening by how dangerous it actually is, using AI plus context, so the team works the real threats first instead of guessing which alert matters.",
      stops: "The team burning hours on noise while the dangerous thing waits in the queue.",
      without: "Every alert looks equally urgent, so the worst one waits behind the trivia.",
    },
    {
      name: "Autonomous playbooks",
      jargon: "SOAR, automated remediation, autonomous playbooks",
      plain: "A 'playbook' is the set of steps an analyst would take to investigate and shut down a specific kind of threat. It runs those steps automatically for the routine cases, the way a seasoned analyst would, so people only handle the hard ones.",
      stops: "Slow, manual, repetitive response letting a threat spread while a human works the queue.",
      without: "A small team hand-handles every alert and cannot keep up.",
    },
    {
      name: "Identity-aware response",
      jargon: "identity-aware containment, isolation",
      plain: "When it shuts a threat down, it ties the action to the specific user or machine account involved, so it isolates exactly the compromised thing without knocking the rest of the business offline.",
      stops: "A blunt response that either misses the real account or takes down half the company to be safe.",
      without: "Containment is a sledgehammer, so teams hesitate to act at all.",
    },
    {
      name: "Replacing the SIEM",
      jargon: "next-gen SIEM, SIEM replacement",
      plain: "A SIEM is the old system that collected logs and made humans read them to find problems. This replaces it: instead of a giant logbook someone has to read, the AI reads it and acts.",
      stops: "Only learning about an attack after a person finds it in the logs.",
      without: "You have a filing cabinet of evidence and nobody with time to open it.",
    },
  ],
};

/** The insight underneath the whole method: jargon is gatekeeping, and the
 *  gates only ever open inward. This is the reason the program exists. */
export const GATEKEEPING = {
  thesis: "Jargon does not just confuse; it gatekeeps, and the gates only ever open inward.",
  points: [
    "Specialists guard their knowledge; engineers understate what a change really involves to protect their own schedule.",
    "Product leaders learn the product only as far as the gatekeeping allows, and are wary of admitting the gaps.",
    "Even the head of engineering, no longer touching the code, is outside the gate.",
    "The trap closes from both sides: the moment a specialist clears the gate, they start speaking the same jargon, because that is how expertise gets signaled.",
  ],
  cost: "Without real understanding, nobody can compare their tools to a competitor's, improve a process, or fully grasp what the company does and sells. Taking the gates down, precisely and without dumbing anything down, is the whole point.",
} as const;

/** The highest-value audience: the role where gatekeeping bites hardest, and the
 *  one nobody trains for yet. */
export const FDE = {
  role: "Forward Deployed Engineer",
  why: "The hottest role in technology right now, and almost nobody trains for it, because it is new and learned entirely on the job. An FDE has cleared every technical gate and now has to open them for a customer, in the customer's own environment, under pressure, in real time.",
  gap: "Being deeply technical is only half the job. The other half is making that depth legible and valuable to the people at the deployment site, and nobody teaches that half.",
  coursework: [
    { covers: "Product depth, told plainly", so: "The engineer can explain what a feature does and why, not just operate it." },
    { covers: "Translation and the room", so: "Turning deep tech into what the customer's people can understand and act on, under pressure." },
    { covers: "Mapping to the customer's system", so: "Connecting the capability to the customer's actual environment and the outcome they care about." },
    { covers: "Driving adoption at the edge", so: "The deployment sticks after the engineer leaves, which is the entire point of the role." },
  ],
} as const;

/** Why the team feels the value, which is the point of the engagement. */
export const WHY_IT_WORKS = [
  "A seller who can say these sentences sounds like they understand what they sell, because they now do.",
  "The customer hears value instead of acronyms, and can repeat it to their own boss.",
  "The pattern scales: the same four beats apply to every feature and every new acquisition Palo Alto brings in.",
];

/** What turns this drawing into an engagement. Held on the page, last, because a
 *  sample that hides what it does not yet know is a sales trick, not a method. */
export const TO_BUILD_OUT = [
  { question: "The rest of the line, and the new acquisitions.", why: "We have taken Cortex XSIAM, the flagship, down to the feature level here. An engagement extends the same treatment across the portfolio and each new acquisition, so the fluency does not decay as the product set grows." },
  { question: "Their words, not ours.", why: "This is written from public knowledge. A real program reads their own decks and calls, so the language matches how their teams already talk and the corrections come from them." },
  { question: "The format the team will actually use.", why: "Whether this lives as a card deck, a one-page-per-product sheet, an onboarding path, or coaching prompts is a change-management decision made with them, not for them." },
];

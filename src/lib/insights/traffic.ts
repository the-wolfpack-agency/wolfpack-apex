/**
 * Telling a person's question from our own machinery asking one.
 *
 * WHAT THIS CAUGHT. The most striking insight produced today was that a single
 * document had answered 754 questions: a reliance risk nobody had, and the
 * headline of a client report. It was our own test traffic. 282 of those
 * citations landed on 30 August and 358 on 29 August, the two days an eval
 * harness and a transcript probe were run against production.
 *
 * Half the query log is not a person: 1,196 of 2,401 rows come from eval,
 * demo-cto, agent-1, transcript-probe, walkthrough, phase1-readiness and the
 * rest of the tooling built this week. Every insight reading that log without
 * this was roughly half wrong, in a direction that flatters whatever we
 * happened to test most.
 *
 * SHAPE, NOT A DENYLIST. A list of our own service names would be right today
 * and wrong the moment somebody adds a script, and it says nothing about a
 * client's deployment. A person signs in and gets an account id or an email
 * address; our machinery passes a word it chose. That distinction holds
 * across deployments in a way a list of names cannot.
 *
 * AND IT IS REPORTED, NEVER SILENT. If a client's people turn out to have
 * usernames rather than account ids, this rule would quietly discard all of
 * them and the insight would read as an empty estate. Every caller is given
 * the split so that "ninety per cent of your traffic was machinery" is visible
 * rather than inferred from a suspiciously small number.
 */

/** An account id issued at sign-in. */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identities our own tooling passes.
 *
 * Not the discriminator, which is shape. This exists so a name that looks
 * person-shaped is still caught: "demo-cto" is neither an account id nor an
 * email, so the shape rule already has it, and this makes the intent explicit
 * for the ones somebody might otherwise argue about.
 */
export const KNOWN_SERVICE_IDENTITIES: readonly string[] = [
  "eval",
  "demo-cto",
  "agent-1",
  "transcript-probe",
  "walkthrough",
  "phase1-readiness",
  "system-mapper",
  "insight-probe",
  "user-parity",
  "proof-agent-1",
  "system",
];

export function isServiceIdentity(userId: string | null | undefined): boolean {
  const id = (userId ?? "").trim();
  if (!id) return true;
  if (KNOWN_SERVICE_IDENTITIES.includes(id.toLowerCase())) return true;
  /* A person has an account id or an email address. Anything else is a word
     some code chose for itself. */
  return !ACCOUNT_ID.test(id) && !id.includes("@");
}

export interface TrafficSplit<T> {
  /** Rows a person is responsible for. */
  human: T[];
  /** Rows our own machinery produced. */
  service: T[];
  /** Share of rows that were machinery, 0 to 1. */
  serviceShare: number;
}

export function splitTraffic<T>(
  rows: readonly T[],
  userIdOf: (row: T) => string | null | undefined,
): TrafficSplit<T> {
  const human: T[] = [];
  const service: T[] = [];
  for (const row of rows) (isServiceIdentity(userIdOf(row)) ? service : human).push(row);
  return {
    human,
    service,
    serviceShare: rows.length === 0 ? 0 : service.length / rows.length,
  };
}

/**
 * How much of what a client is about to read came from a person.
 *
 * Said whenever the share is high enough to change how a number should be
 * read. The threshold is deliberately low: a fifth of an insight being our own
 * machinery is already enough to move a ranking.
 */
export const NOTABLE_SERVICE_SHARE = 0.2;

export function describeTraffic(split: TrafficSplit<unknown>): string | null {
  if (split.serviceShare < NOTABLE_SERVICE_SHARE) return null;
  const pct = Math.round(split.serviceShare * 100);
  return (
    `${pct} per cent of this activity came from testing and tooling rather than from a person, ` +
    `and is excluded. If that share looks wrong, it is worth checking how people sign in here: ` +
    `this tells them apart by whether the identity is an account or a name some code chose.`
  );
}

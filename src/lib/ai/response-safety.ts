/**
 * What the model sent back, read before anybody acts on it.
 *
 * THE GAP THIS CLOSES. Outbound prompts are redacted, inbound responses are
 * redacted for secrets, and verifyAnswer checks the SHAPE of an answer - empty,
 * truncated, refused. Nothing looked at what a response actually contains.
 *
 * That is fine while every model is one we picked. It stops being fine the
 * moment a provider is added by an environment variable, which is now three
 * variables and no code. A model served from a base URL somebody typed can
 * return whatever it likes, and the product hands its output to a person who
 * will reasonably assume it was checked.
 *
 * WHAT THIS IS NOT. Not a classifier, not a jailbreak detector, and not a
 * substitute for a person reading code before running it. It looks for a small
 * number of shapes that are almost never innocent in an answer, and it says
 * which one fired so the finding can be argued with. A rule somebody can read
 * is worth more here than a score they cannot, because the thing on the other
 * end of this is a refusal that has to be explained.
 *
 * THE DISCRIMINATOR IS COMBINATION, NOT MENTION. This product writes code and
 * talks about environment variables all day. `process.env` in an answer is
 * ordinary. `process.env` read into a fetch to a host nobody mentioned is
 * exfiltration wearing a code block, and the difference is the whole reason
 * this can be shipped without drowning in false positives.
 */

export type ResponseRisk =
  /** Reads credentials and sends them somewhere in the same breath. */
  | "credential_exfiltration"
  /** Fetches a script and executes it unseen. */
  | "remote_code_execution"
  /** Instructions aimed at whatever reads this next, not at the reader. */
  | "downstream_injection"
  /** A destructive command with no confirmation around it. */
  | "destructive_command";

export interface ResponseFinding {
  risk: ResponseRisk;
  /** The matched fragment, short and quotable in an audit row. */
  evidence: string;
  /** Why this shape is the problem, in one sentence. */
  reason: string;
}

/** Reading a secret. Ordinary on its own. */
/* THE LEADING \b USED TO WRAP THIS WHOLE GROUP, and it silently killed four of
   the seven branches. A word boundary before `$`, `~` or `.` requires a word
   character immediately to the left, and shell variables and credential paths
   are preceded by a space, a quote or an equals sign. So `$AWS_SECRET_ACCESS_KEY`,
   `~/.aws/credentials`, `~/.ssh/id_rsa` and a standalone `.env` could never
   match, while `process.env`, `os.environ` and `System.getenv(` always did
   because they begin with word characters.

   The tests all passed. Every one of them used the JavaScript form, so the
   half of this rule aimed at shell payloads had never been exercised, and the
   shell form is the one an exfiltration payload actually takes. The boundary
   now sits on the branches it helps and nowhere else. */
const SECRET_READ =
  /\bprocess\.env(?:\.\w+|\[['"][^'"]+['"]\])|\bos\.environ(?:\.get\()?|\bSystem\.getenv\(|\$\{?(?:AWS_SECRET|API_KEY|SECRET|TOKEN|PASSWORD)\w*\}?|~\/\.aws\/credentials|~\/\.ssh\/id_\w+|(?<!\w)\.env\b/i;

/** Sending something out. Ordinary on its own. */
const NETWORK_SEND =
  /\b(?:fetch\s*\(|axios\.(?:post|get)\s*\(|requests\.(?:post|get)\s*\(|curl\s+|wget\s+|nc\s+-|Invoke-WebRequest)/i;

/** Fetch-and-run, which is the shape rather than the tool. */
const PIPE_TO_SHELL =
  /(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b|\biex\s*\(\s*(?:new-object|iwr|invoke-webrequest)/i;

/** Talking past the reader to whatever consumes this next. */
const DOWNSTREAM_INSTRUCTION =
  /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|disregard (?:the )?(?:system|previous) (?:prompt|instructions)|you are now (?:in )?developer mode|<\|im_start\|>|\[\[SYSTEM\]\])/i;

/** Destruction with no way back and no confirmation in sight. */
const DESTRUCTIVE =
  /\brm\s+-rf\s+[~/]\S*|\bDROP\s+(?:DATABASE|TABLE)\b|\bTRUNCATE\s+TABLE\b|\bgit\s+push\s+--force\b[^\n]*\bmain\b|\bDELETE\s+FROM\s+\w+\s*(?:;|$)/i;

function quote(source: string, re: RegExp): string {
  const m = re.exec(source);
  return m ? m[0].replace(/\s+/g, " ").slice(0, 90) : "";
}

/**
 * Read one model response.
 *
 * Returns every shape that fired. An empty array is not a promise the answer
 * is safe: it means none of these specific shapes appeared, which is a smaller
 * and more honest claim.
 */
export function inspectResponse(content: string): ResponseFinding[] {
  const found: ResponseFinding[] = [];
  if (!content) return found;

  /* COMBINATION, NOT MENTION. Either half alone is ordinary in a product that
     writes code for a living; together in one answer they are the shape of
     credentials leaving. */
  if (SECRET_READ.test(content) && NETWORK_SEND.test(content)) {
    found.push({
      risk: "credential_exfiltration",
      evidence: quote(content, SECRET_READ),
      reason:
        "the answer reads credentials and makes a network call in the same body, which is the shape of exfiltration rather than of example code",
    });
  }

  if (PIPE_TO_SHELL.test(content)) {
    found.push({
      risk: "remote_code_execution",
      evidence: quote(content, PIPE_TO_SHELL),
      reason: "the answer fetches a script and executes it without it ever being read",
    });
  }

  if (DOWNSTREAM_INSTRUCTION.test(content)) {
    found.push({
      risk: "downstream_injection",
      evidence: quote(content, DOWNSTREAM_INSTRUCTION),
      reason:
        "the answer contains instructions addressed to a system rather than to the reader, which only matters if something downstream will obey them",
    });
  }

  if (DESTRUCTIVE.test(content)) {
    found.push({
      risk: "destructive_command",
      evidence: quote(content, DESTRUCTIVE),
      reason: "the answer contains an irreversible command with no confirmation around it",
    });
  }

  return found;
}

/** True when anything fired. Kept separate so a caller can log without gating. */
export function responseIsSuspect(content: string): boolean {
  return inspectResponse(content).length > 0;
}

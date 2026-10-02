/**
 * SINGLE SOURCE OF TRUTH for the security pattern signatures the factory uses.
 *
 * WHY THIS EXISTS: the same CWE signature (eval(), SQL interpolation,
 * dangerouslySetInnerHTML, Math.random() in a credential context, a credential
 * name) was previously declared independently in BOTH the diff-line gate
 * (the diff-line gate) AND the whole-file scanner
 * (platform-scan/static/detectors.ts). Two copies of one regex drift: a fix or a
 * precision tweak in one did not reach the other, and a new detector could be
 * added to one engine while the other silently stayed blind. That is the exact
 * DRY failure this module closes.
 *
 * Each concept's REGEX + CWE live here ONCE. Both engines import from here:
 *   - detect.ts builds its diff-line RULES from these patterns.
 *   - detectors.ts's single-line security detectors match on these patterns
 *     (keeping their own multi-line guards/precision on top).
 *
 * Severity is intentionally NOT fixed here: the two layers apply it by policy
 * (detect.ts is the fast diff triage; the deep-scan/platform-scan engine is the
 * blocking author-time scan), but they must agree on WHAT the pattern IS. When a
 * pattern needs tuning, tune it here and both engines move together.
 *
 * Pure, zero-dep, line-oriented (mirrors the rest of the scanner).
 */

/** eval(...) that is NOT a method call (obj.eval is excluded), or new Function(...). */
export const EVAL_EXEC = /(?<![.\w$])eval\s*\(/;
export const DYNAMIC_FUNCTION = /\bnew\s+Function\s*\(/;
/** child_process command execution - exec/execSync/execFile or the module itself. */
export const CHILD_PROCESS_EXEC = /\bexec(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(|child_process/;

/** A SQL keyword that marks a line as building a query. */
export const SQL_KEYWORD = /\b(select|insert\s+into|update|delete\s+from|where|from)\b/i;
/** A ${...} interpolation inside a (SQL) string. */
export const SQL_INTERP = /\$\{[^}]+\}/;
/** String-concatenation into a SQL string: '...' + x  or  x + '...'. */
export const SQL_CONCAT = /['"]\s*\+|\+\s*['"]/;
/** $1,$2 placeholders - the SAFE parameterized form, never flagged. */
export const SQL_PARAMETERIZED = /\$\d+\b/;

/** The React raw-HTML injection sink (narrow: the JSX prop only). */
export const DANGEROUS_INNER_HTML = /\bdangerouslySetInnerHTML\b/;
/** The full raw-HTML injection sink set: the JSX prop OR a .innerHTML assignment. */
export const DANGEROUS_HTML = /\bdangerouslySetInnerHTML\b|\.innerHTML\s*=/;

/** Math.random() - not a CSPRNG. */
export const MATH_RANDOM = /\bMath\s*\.\s*random\s*\(\s*\)/;

/**
 * A credential / single-use-link identifier, matched as CODE (plain word OR a
 * camelCase tail like sessionToken/resetUrl). The reset/verify/invite link family
 * is explicit: those links are bearer credentials for one account.
 */
export const CRED_NAME =
  /\b(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|priv[_-]?key|session[_-]?id|jwt|bearer|credentials?|otp|(?:reset|verify|verification|invite|confirm|activation|magic)[_-]?(?:link|url|token))\b|\b[A-Za-z]+(?:Token|Secret|Password|Passwd|ApiKey|PrivateKey|SessionId|AccessToken|RefreshToken|ClientSecret|Otp|Jwt|Credential)\b/i;

/**
 * Credential context used to gate weak-randomness: a Math.random() only matters
 * for security when a credential word sits on/near the line. Narrower than
 * CRED_NAME on purpose (the generic link family is not a randomness concern).
 */
export const CRED_CONTEXT =
  /\b(?:token|secret|pass(?:word|wd)?|pwd|otp|nonce|salt|api[_-]?key|apikey|session[_-]?id|csrf|verification|verify|reset|invite|activation|magic|auth[_-]?code|access[_-]?code|private[_-]?key)\b|\b[A-Za-z]+(?:Token|Secret|Password|Passwd|ApiKey|PrivateKey|SessionId|Otp|Nonce|Salt|Csrf)\b/i;

/** TLS certificate validation turned off - MITM exposure. */
export const TLS_DISABLED = /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/;

/** A broken hash algorithm (MD5 / SHA-1) passed to crypto.createHash. */
export const WEAK_HASH = /\bcreateHash\s*\(\s*['"](?:md5|sha-?1)['"]/i;

/**
 * Provider API-key formats shared by the general secret scanner
 * (platform-scan SECRET_PROVIDERS) and the AI-surface key detector
 * (ai-surface KEY_SIGNATURES). Defined once so they can't drift - they already
 * HAD drifted: the AI-surface OpenAI regex carried a `(?!ant-)` negative-lookahead
 * (so an Anthropic key isn't also counted as OpenAI) that the platform-scan copy
 * lacked. This is the single, correct definition.
 */
export const SECRET_ANTHROPIC = /\bsk-ant-[A-Za-z0-9_-]{24,}\b/;
export const SECRET_OPENAI = /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/;
export const SECRET_GOOGLE = /\bAIza[0-9A-Za-z_-]{35}\b/;

/** The AI-provider key signatures (slug + regex) - the AI-surface subset of the
 *  shared provider list. */
export const AI_PROVIDER_KEY_SIGNATURES: ReadonlyArray<{ re: RegExp; provider: string }> = [
  { re: SECRET_ANTHROPIC, provider: "anthropic" },
  { re: SECRET_OPENAI, provider: "openai" },
  { re: SECRET_GOOGLE, provider: "google" },
];

/** Permissive CORS: Allow-Origin: * or cors origin:true/'*'. */
export const OPEN_CORS = /access-control-allow-origin['"]?\s*[:,]\s*['"]\*/i;
export const OPEN_CORS_OPTION = /\borigin\s*:\s*(?:true|['"]\*['"])/;

/** A SQL line is injection-shaped: a keyword plus interpolation/concat, not parameterized. */
export function isSqlInjectionLine(line: string): boolean {
  if (!SQL_KEYWORD.test(line)) return false;
  if (SQL_PARAMETERIZED.test(line)) return false;
  return SQL_INTERP.test(line) || SQL_CONCAT.test(line);
}

/** eval / new Function / child_process exec on a line. */
export function isCodeExecLine(line: string): boolean {
  return EVAL_EXEC.test(line) || DYNAMIC_FUNCTION.test(line) || CHILD_PROCESS_EXEC.test(line);
}

/** Math.random() used where a credential word is present (weak randomness). */
export function isWeakRandomLine(line: string): boolean {
  return MATH_RANDOM.test(line) && CRED_CONTEXT.test(line);
}

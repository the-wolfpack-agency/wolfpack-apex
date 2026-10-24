# From a new advisory to a Forcefield rule

When a security advisory describes a new attack, this is how it becomes something Forcefield recognizes on every site we protect, with proof that it catches the attack and does not block real visitors. Written for someone who is not a security specialist: each step says what to do and why.

## First: is this a Forcefield problem at all?

Forcefield sits in front of a website and looks at each incoming request. It sees the path, the query string, the method, the user agent and the names of the request headers. It does not see header values or request bodies.

Ask which of these the advisory is:

| The advisory describes | Where it goes |
| --- | --- |
| A malicious package or container image (an npm, PyPI or Docker release) | Not Forcefield. Add it to `security/known-compromised.json` with its primary source; the daily supply-chain sweep then checks every repository. |
| A weakness in a Microsoft 365, Entra or Azure setting | Not Forcefield. Add it to the [monthly review](monthly-review.md), or to `scripts/security/` as a check. |
| A header or banner our sites send, or a file they should not serve | `scripts/security/surface-sites.json` and `scripts/security/lib/surface.ts`, the weekly surface probe. |
| Something an attacker sends to a website: a tool, a path, a string in the URL | Forcefield. Continue below. |

## Step 1: write down one real example of the attack

From the advisory (or the researcher's write-up it links to), copy one concrete request the attack makes: the URL, the user agent, anything distinctive. Keep the link to the source. If the advisory gives no example, find one in the original write-up before going further. A rule written without a real sample is a guess.

## Step 2: choose the kind of rule

There are two places a rule can live. Pick the first one that fits.

**A. Data in the central ruleset**, `DEFAULT_RULESET` in `src/lib/forcefield-web/ruleset.ts`. This is a list, not code, and it is also served centrally from `/api/forcefield/ruleset`, so once it is deployed every connected site picks it up within minutes without being redeployed. Use it when the attack is recognizable by:

- **the tool's name in the user agent**: add a line to `toolSignatures` (the list starts as `DEFAULT_TOOL_SIGNATURES` in `fingerprint.ts`): display name, the lower-case text to look for, and the type (`scanner` for attack tools). Requests from it are blocked.
- **a path that does not exist on our sites and is only ever probed** (for example `/.env`, `/wp-login.php`): add it to `sensitivePaths`. These are recorded, not blocked, because a curious person can type a path too.
- **a decoy path we planted** that no real visitor can see: `trapPaths`. A request there is blocked.

**B. A payload signature in code**, `PAYLOAD_SIGNATURES` in `src/lib/forcefield-web/enforce.ts`. Use it when the attack is a string inside the URL that a legitimate request never contains (a SQL fragment, a template-injection probe, a JNDI lookup). Each signature is a pattern under an attack family. Because the engine is copied into each site, a change here reaches a site when it is re-vendored (`node scripts/forcefield-vendor.mjs <site repo>`), not instantly.

Precision comes before coverage. A missed attack is still recorded by monitoring; a false block turns a real customer away. If the only pattern you can write would also match ordinary traffic, the rule belongs in monitoring (report-only), not in blocking.

## Step 3: prove it, both ways

Add two cases to `ADVERSARIAL_CORPUS` in `src/lib/forcefield-web/adversarial-corpus.ts`:

1. **The attack must fire.** The real example from step 1, marked `hostile`, `expectBlock: true`, with the reason you expect (`attack_tool`, `payload` or `decoy`). Recon-only paths are marked `recon` with `expectBlock: false`.
2. **A real browser must not.** The closest legitimate request you can think of, marked `benign`, `expectBlock: false`. For a SQL rule, a search for a word like "select"; for a template rule, a page that legitimately shows `{{name}}`. Use the corpus's existing `BROWSER_UA` and `BROWSER_HEADERS` so it looks like Chrome.

The corpus test (`src/lib/forcefield-web/__tests__/adversarial-corpus.test.ts`) runs every case through the real engine, `decideEnforcement`, and fails the build if a hostile case is let through or a benign one is blocked. Run it:

```bash
npx jest src/lib/forcefield-web src/lib/forcefield
```

## Step 4: update the coverage map

`THREAT_COVERAGE` in `src/lib/forcefield/threat-coverage.ts` is the honest list of which threats we detect and which we do not. Add or update the row for the threat (by CWE number, or OWASP-LLM id for AI attacks):

- Mark it `covered` only when a corpus sample of that attack runs through the engine and is caught, as in step 3. A row is a claim, and the sample is its evidence.
- Use `partial` when only one form of the attack is caught, and say which in the note.
- If you could not write a safe rule, leave or mark the row `gap`, with a note saying why. A named gap is useful; a quiet one is not.

The coverage tests (`src/lib/forcefield/__tests__/threat-coverage.test.ts`) check the rows are well formed and stay in step with the detectors.

## Step 5: ship and confirm

1. Open a pull request with the rule, the two corpus cases and the coverage row together, and the advisory link in the description.
2. After merge and deploy, a data rule (step 2A) reaches connected sites through the central ruleset; a payload signature (step 2B) needs each site re-vendored.
3. Confirm on a live site: `npm run forcefield:redteam` replays the corpus against a deployed shim.

## Example

Advisory: a new scanner, "ExampleScan", probes for exposed configuration files and identifies itself as `ExampleScan/2.0` in its user agent.

1. Sample: `GET /config.php.bak` with user agent `ExampleScan/2.0 (+https://example.test)`.
2. Rule: data. Add `["ExampleScan", "examplescan", "scanner"]` to the tool signatures.
3. Proof: a `hostile` corpus case with that user agent (expect `attack_tool`), and a `benign` case for a browser fetching `/pricing`.
4. Coverage: the matching exposure-recon row (here CWE-200, sensitive-information probes) notes the new tool in its note.
5. Ship: merge; connected sites pick up the ruleset on their next refresh.

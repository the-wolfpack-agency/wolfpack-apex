# AgenticQA security self-scan

Workflow: `.github/workflows/security-self-scan.yml`. Runs on pull requests, on pushes to `main` that touch `src/`, weekly (Sunday 02:00 UTC), and on demand (`gh workflow run security-self-scan.yml --ref <branch>`). Gate and report logic: `scripts/security/self-scan.ts` and `scripts/security/lib/self-scan.ts`.

| Job | Fails when |
| --- | --- |
| Static Security Scan | a critical or high finding in the six key scanners (auth bypass, IDOR, JWT, rate limit, error disclosure, security headers) is not in `.agenticqa/scan-baseline.json`, or a key scanner errored or is missing from the output |
| Pentest Validation | a confirmed critical or high vulnerability, or the pentest phase did not run |
| Dependency Audit | a high or critical advisory in production dependencies, or `npm audit` produced no counts |
| Scan Summary | never; it reports. On a scheduled run where any job failed it opens an issue |

## Public repository: counts only

This repository is public, so its run logs, job summaries, PR comments, issues and artifacts can be read by anyone. The workflow never prints finding details there:

- the scanners write to a file and their console output is discarded (`--json` would print every finding);
- the gate prints and outputs numbers only unless the workflow says the repository is private (`SECURITY_REPORT_PUBLIC`, the same fail-closed rule as the scheduled checks in [scheduled-checks.md](scheduled-checks.md));
- the result files are uploaded as artifacts only when `github.event.repository.private` is true;
- the summary job is built from job outputs that hold counts, and downloads no artifacts.

To see the findings, run the scanner on your own machine (below).

## Seeing the findings and changing the baseline

The baseline changes only through a reviewed commit. CI reads it and never writes it, so a new finding keeps the job red until it is fixed or deliberately accepted.

```bash
# 1. A local AgenticQA checkout (private: nhomyk/AgenticQA)
git clone https://github.com/nhomyk/AgenticQA.git ../AgenticQA
python3 -m venv .venv-agenticqa && .venv-agenticqa/bin/pip install -e ../AgenticQA/AgenticQA

# 2. Scan this repository to a file outside the repo (never commit it)
.venv-agenticqa/bin/python ../AgenticQA/AgenticQA/scripts/run_client_scan.py . --output /tmp/scan-results.json

# 3. See what is new against the committed baseline (full detail locally)
npm run security:self-scan -- static --scan /tmp/scan-results.json --md /tmp/self-scan.md

# 4. Only if every new finding has been reviewed and accepted:
npm run security:self-scan -- baseline --scan /tmp/scan-results.json --note "accepted <rules> after review in #<PR>"
git diff .agenticqa/scan-baseline.json   # read it, then commit it in a PR
```

`baseline` refuses to run inside GitHub Actions and requires `--note`, so a baseline change always arrives as a commit with a reason.

Fingerprints are line-independent (`file | cwe | rule | normalized snippet`), the same function as AgenticQA's `finding_fingerprint.py`; the TypeScript port is pinned to the Python output by `src/__tests__/security-checks/self-scan.test.ts`.

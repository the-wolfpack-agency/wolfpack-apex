#!/usr/bin/env python3
"""Turn a raw AgenticQA scan into an HONEST report + the enforcing gate.

WHY THIS EXISTS. The scan comment used to compute each scanner's Status as
``PASS if raw_critical == 0 else FAIL``. That is not what the pipeline actually
enforces: the gate fails only on findings NOT already in the committed baseline
(``.agenticqa/scan-baseline.json``). So a persistent, known finding sitting in
the baseline made the table shout "FAIL / risk=critical" on every green PR,
while the real gate passed. The banner and the gate disagreed, and the banner
was the one people saw. A client reading "74 critical" on a PR that merged green
learns to distrust the tool.

This script makes ONE source of truth for both the table and the gate:

  * Suppressions (``.agenticqa/suppressions.json``) are dropped first. These are
    human-verified false positives, each with a recorded reason. A public
    build-version route is not an "auth bypass"; a login endpoint is not one
    either. Suppressing them is documented, reviewable, and reversible.

  * A scanner's Status is PASS unless it has a NEW critical/high finding — one
    that is neither suppressed nor already in the baseline. Baseline findings
    still show in the counts (nothing is hidden) but do not, by themselves,
    turn the row red, because the gate does not fail on them.

  * The process exits non-zero iff there is at least one new, unsuppressed
    critical/high finding across the gate scanners. Report and gate can never
    disagree again, because they are the same computation.

Pure standard library so it runs identically in the CI heredoc replacement and
under pytest. The fingerprint is imported from the vendored tool when available
and falls back to an inline copy so this script is testable without the tool
checked out.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Set, Tuple

# The six scanners the pipeline actually gates on. Everything else in the scan
# (architecture map, legal_risk, hipaa, ...) is advisory and never fails a PR,
# so it is summarized but not turned into a red Status here.
GATE_SCANNERS: List[str] = [
    "auth_bypass", "idor", "jwt_security",
    "rate_limit", "error_disclosure", "security_headers",
]

_GATING_SEVERITIES = {"critical", "high"}


# ── Fingerprint (line-independent finding identity) ───────────────────────────
# Prefer the tool's canonical implementation; fall back to an identical inline
# copy so this file is unit-testable without the vendored tool present.
try:  # pragma: no cover - exercised only when the tool is present
    try:
        # CI pip-installs the tool, so the plain import usually resolves.
        from agenticqa.security.finding_fingerprint import fingerprint  # type: ignore
    except Exception:
        # Fall back to the vendored checkout path the workflow uses.
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                               / "vendor" / "agenticqa-tool" / "AgenticQA" / "src"))
        from agenticqa.security.finding_fingerprint import fingerprint  # type: ignore
except Exception:  # pragma: no cover - the common local/test path
    _WS = re.compile(r"\s+")

    def _normalize_snippet(text: Any) -> str:
        return _WS.sub(" ", str(text or "")).strip().lower()[:160]

    def fingerprint(finding: Mapping[str, Any]) -> str:
        file = str(finding.get("file", "") or "")
        cwe = str(finding.get("cwe", "") or "")
        rule = str(finding.get("rule_id", "") or "")
        snippet = _normalize_snippet(
            finding.get("evidence") or finding.get("message") or ""
        )
        basis = f"{file}|{cwe}|{rule}|{snippet}"
        return hashlib.sha256(basis.encode()).hexdigest()[:16]


def load_suppressions(path: Path) -> List[Dict[str, str]]:
    """Read the reviewed-false-positive allowlist. Missing file → no
    suppressions (fail safe: nothing is hidden by accident)."""
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return list(data.get("suppressions", []))


def is_suppressed(scanner: str, finding: Mapping[str, Any],
                  suppressions: List[Dict[str, str]]) -> bool:
    """A finding is suppressed when an allowlist entry matches its scanner and
    file (and an optional message substring). File match is exact on the
    scanner's reported path. A blank reason never suppresses — a suppression
    without a recorded reason is not a suppression."""
    ffile = str(finding.get("file", "") or "")
    fmsg = str(finding.get("message", "") or "")
    for s in suppressions:
        if not s.get("reason"):
            continue
        if s.get("scanner") and s["scanner"] != scanner:
            continue
        if s.get("file") and s["file"] != ffile:
            continue
        needle = s.get("message_contains")
        if needle and needle not in fmsg:
            continue
        return True
    return False


def analyze(scan: Mapping[str, Any], baseline: Set[str],
            suppressions: List[Dict[str, str]]) -> Dict[str, Any]:
    """Compute per-scanner rows + the overall gate result from one scan."""
    scanners = scan.get("scanners", {})
    rows: List[Dict[str, Any]] = []
    total_new_gating = 0

    for name in GATE_SCANNERS:
        sc = scanners.get(name, {})
        if sc.get("status") == "ok":
            findings = sc["result"].get("findings", [])
            kept = [f for f in findings if not is_suppressed(name, f, suppressions)]
            suppressed = len(findings) - len(kept)
            crit = sum(1 for f in kept
                       if str(f.get("severity")) in _GATING_SEVERITIES)
            new_crit = sum(
                1 for f in kept
                if str(f.get("severity")) in _GATING_SEVERITIES
                and fingerprint(f) not in baseline
            )
            total_new_gating += new_crit
            rows.append({
                "scanner": name,
                "findings": len(kept),
                "critical": crit,
                "new_critical": new_crit,
                "suppressed": suppressed,
                # PASS unless there is a NEW (unbaselined, unsuppressed) critical.
                "status": "FAIL" if new_crit else "PASS",
            })
        elif sc.get("status") == "error":
            rows.append({"scanner": name, "findings": "err", "critical": "err",
                         "new_critical": 0, "suppressed": 0, "status": "ERROR"})
        else:
            rows.append({"scanner": name, "findings": "-", "critical": "-",
                         "new_critical": 0, "suppressed": 0, "status": "SKIP"})

    return {"rows": rows, "total_new_gating": total_new_gating}


def render_table(analysis: Mapping[str, Any]) -> str:
    """Markdown table. Status reflects the gate; a Known column makes baseline /
    suppressed findings visible so nothing looks hidden."""
    lines = ["| Scanner | Findings | Critical | Known | Status |",
             "|---------|----------|----------|-------|--------|"]
    for r in analysis["rows"]:
        display = r["scanner"].replace("_", " ").title()
        known = r["critical"] - r["new_critical"] if isinstance(r["critical"], int) else "-"
        known_cell = f"{known}" + (f" +{r['suppressed']} suppressed"
                                   if r.get("suppressed") else "")
        lines.append(
            f"| {display} | {r['findings']} | {r['critical']} | "
            f"{known_cell} | {r['status']} |"
        )
    return "\n".join(lines)


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("scan_results", type=Path)
    ap.add_argument("--baseline", type=Path, default=Path(".agenticqa/scan-baseline.json"))
    ap.add_argument("--suppressions", type=Path, default=Path(".agenticqa/suppressions.json"))
    ap.add_argument("--table-out", type=Path, help="write the markdown table here")
    ap.add_argument("--github-output", type=Path,
                    help="append total_findings/total_critical/risk_level/"
                         "critical_in_key_scanners to this $GITHUB_OUTPUT file")
    ap.add_argument("--gate", action="store_true",
                    help="exit 1 if any NEW unsuppressed critical/high exists")
    args = ap.parse_args(argv)

    scan = json.loads(args.scan_results.read_text())
    try:
        baseline = set(json.loads(args.baseline.read_text()).get("finding_hashes", []))
    except (FileNotFoundError, json.JSONDecodeError):
        baseline = set()
    suppressions = load_suppressions(args.suppressions)

    analysis = analyze(scan, baseline, suppressions)
    table = render_table(analysis)

    summary = scan.get("summary", {})
    raw_total = summary.get("total_findings", 0)
    raw_crit = summary.get("total_critical", 0)
    new_gating = analysis["total_new_gating"]

    report = (
        f"{table}\n\n"
        f"**Gating result**: {new_gating} new critical/high in the gate scanners "
        f"→ {'FAIL' if new_gating else 'PASS'}. "
        f"(Advisory scan totals, not gating: {raw_total} findings, "
        f"{raw_crit} critical across all scanners, mostly the architecture map.)"
    )
    print(report)
    if args.table_out:
        args.table_out.write_text(report)

    if args.github_output:
        with args.github_output.open("a") as out:
            out.write(f"total_findings={raw_total}\n")
            out.write(f"total_critical={raw_crit}\n")
            out.write(f"risk_level={summary.get('risk_level', 'unknown')}\n")
            out.write(f"critical_in_key_scanners={new_gating}\n")

    if args.gate and new_gating:
        print(f"::error::{new_gating} new unsuppressed critical/high finding(s)",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

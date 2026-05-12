#!/usr/bin/env python3
"""
probe_error_disclosure.py — hit endpoints designed to trigger errors,
assert no stack traces / framework names / file paths leak.

Detects:
  - "TypeError:" / "RangeError:" / "AttributeError:" in body
  - "/Users/" / "/home/" in body (filesystem path leak)
  - "node_modules" / "site-packages" framework leak
  - "at " followed by file:line stack frame pattern

Used by .github/workflows/nightly-dast.yml.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from typing import List


# Endpoints designed to trigger errors. The probe expects a polite 4xx
# with a sanitized body — leakage of stack/path/framework details is a
# regression.
PROBE_PATHS: List[str] = [
    "/api/automations/__nope__/poll",
    "/api/sites/__nope__",
    "/api/contacts/__nope__",
    "/api/__bogus_endpoint__",
]

LEAK_PATTERNS: List[re.Pattern[str]] = [
    re.compile(r"\b(?:TypeError|RangeError|AttributeError|ReferenceError|SyntaxError):", re.IGNORECASE),
    re.compile(r"/(?:Users|home|var|opt)/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|py)"),
    re.compile(r"\bnode_modules/[A-Za-z0-9_./-]+"),
    re.compile(r"\bsite-packages/[A-Za-z0-9_./-]+"),
    re.compile(r"\bat\s+[A-Za-z0-9_$.<>]+\s+\([^)]+:\d+:\d+\)"),  # stack frame
    re.compile(r"\bnext-server/[A-Za-z0-9_./-]+"),
]


def probe(url: str) -> dict:
    findings = []
    for path in PROBE_PATHS:
        full = url.rstrip("/") + path
        try:
            req = urllib.request.Request(full, method="GET")
            resp = urllib.request.urlopen(req, timeout=15)  # noqa: S310
            status = resp.status
            body = resp.read(64_000).decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            status = e.code
            body = e.read(64_000).decode("utf-8", errors="ignore")
        except Exception as exc:  # noqa: BLE001
            findings.append({"path": path, "error": str(exc)})
            continue
        for pat in LEAK_PATTERNS:
            m = pat.search(body)
            if m:
                findings.append(
                    {
                        "path": path,
                        "status": status,
                        "leak": m.group(0)[:100],
                        "leak_pattern": pat.pattern[:60],
                    }
                )
                break
    return {"url": url, "leaks": findings, "leak_count": len(findings)}


def main(url: str) -> int:
    result = probe(url)
    print(json.dumps(result, indent=2))
    return 1 if result["leak_count"] > 0 else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: probe_error_disclosure.py <url>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))

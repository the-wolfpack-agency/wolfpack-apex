#!/usr/bin/env python3
"""
probe_security_headers.py — fetch the deployed URL and check for the
recommended security response headers. Emits JSON to stdout.

Used by .github/workflows/nightly-dast.yml. Runs on the GitHub runner
with stdlib only — no Vibium / Playwright needed for header probes.

Usage:
    python scripts/probe_security_headers.py https://wolfpack-instinct.vercel.app
"""

from __future__ import annotations

import json
import sys
import urllib.request
from typing import Dict, List


REQUIRED: List[Dict[str, str]] = [
    {"name": "content-security-policy", "severity": "high"},
    {"name": "strict-transport-security", "severity": "high"},
    {"name": "x-frame-options", "severity": "medium"},
    {"name": "x-content-type-options", "severity": "medium"},
    {"name": "referrer-policy", "severity": "low"},
    {"name": "permissions-policy", "severity": "low"},
]


def main(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    try:
        resp = urllib.request.urlopen(req, timeout=15)  # noqa: S310
    except Exception:  # noqa: BLE001
        # HEAD may be 405 / blocked — fall back to GET
        try:
            resp = urllib.request.urlopen(  # noqa: S310
                urllib.request.Request(url, method="GET"), timeout=15
            )
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": str(exc), "missing_count": -1}))
            return 1
    headers_lower = {k.lower(): v for k, v in resp.headers.items()}
    out: List[Dict[str, object]] = []
    missing = 0
    for h in REQUIRED:
        present = h["name"] in headers_lower
        if not present:
            missing += 1
        out.append(
            {
                "name": h["name"],
                "present": present,
                "value": headers_lower.get(h["name"], ""),
                "severity": h["severity"],
            }
        )
    print(
        json.dumps(
            {
                "url": url,
                "status": resp.status,
                "missing_count": missing,
                "headers": out,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: probe_security_headers.py <url>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))

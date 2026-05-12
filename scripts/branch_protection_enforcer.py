#!/usr/bin/env python3
"""
branch_protection_enforcer.py — assert (and optionally apply) branch
protection settings via the GitHub API. Codifies what would otherwise
be a manual click-through in repo Settings → Branches.

Required protections (per CLAUDE.md "deployment safety" + SOC2 CC6):
  - Require pull request reviews before merging (≥1 reviewer)
  - Dismiss stale approvals on new commits
  - Require status checks to pass before merge
  - Require branches up-to-date before merge
  - Require signed commits
  - Block force pushes
  - Block deletions
  - Restrict who can push (no direct pushes to main)

Usage:
    GITHUB_TOKEN=... python scripts/branch_protection_enforcer.py \\
      --repo the-wolfpack-agency/wolfpack-apex \\
      --branch main \\
      [--apply]

Without --apply: just diffs current vs. expected, exits 1 if drift.
With --apply: PUTs the desired config (requires admin token).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict


DESIRED: Dict[str, Any] = {
    "required_status_checks": {
        "strict": True,
        "contexts": ["Verify"],  # the canonical CI gate
    },
    "enforce_admins": True,
    "required_pull_request_reviews": {
        "dismiss_stale_reviews": True,
        "require_code_owner_reviews": False,  # CODEOWNERS optional
        "required_approving_review_count": 1,
    },
    "restrictions": None,
    "required_linear_history": True,
    "allow_force_pushes": False,
    "allow_deletions": False,
    "block_creations": False,
    "required_conversation_resolution": True,
    "lock_branch": False,
    "allow_fork_syncing": False,
    "required_signatures": True,
}


def gh_api(token: str, path: str, method: str = "GET", body: Dict[str, Any] | None = None) -> Dict[str, Any]:
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        method=method,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "agenticqa-branch-protection",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode("utf-8", errors="ignore")}


def diff(current: Dict[str, Any]) -> Dict[str, Any]:
    """Return a dict of (key → (current, desired)) for every drift."""
    out: Dict[str, Any] = {}
    for k, v in DESIRED.items():
        cur = current.get(k)
        # GitHub API normalizes some bool fields under nested {"enabled": true}
        if isinstance(cur, dict) and "enabled" in cur:
            cur = cur["enabled"]
        if isinstance(v, dict):
            sub_drift: Dict[str, Any] = {}
            for sk, sv in v.items():
                cur_sub = (cur or {}).get(sk) if isinstance(cur, dict) else None
                if cur_sub != sv:
                    sub_drift[sk] = {"current": cur_sub, "desired": sv}
            if sub_drift:
                out[k] = sub_drift
        elif cur != v:
            out[k] = {"current": cur, "desired": v}
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--branch", default="main")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("error: GITHUB_TOKEN or GH_TOKEN required", file=sys.stderr)
        return 2

    current = gh_api(token, f"/repos/{args.repo}/branches/{args.branch}/protection")
    if "_error" in current:
        if current["_error"] == 404:
            print(json.dumps({"status": "no_protection", "drift": DESIRED}, indent=2))
            if args.apply:
                gh_api(
                    token,
                    f"/repos/{args.repo}/branches/{args.branch}/protection",
                    method="PUT",
                    body=DESIRED,
                )
                print("applied desired protection")
            return 1
        print(json.dumps(current, indent=2))
        return 2

    drift = diff(current)
    print(
        json.dumps(
            {"repo": args.repo, "branch": args.branch, "drift_count": len(drift), "drift": drift},
            indent=2,
        )
    )
    if drift and args.apply:
        gh_api(
            token,
            f"/repos/{args.repo}/branches/{args.branch}/protection",
            method="PUT",
            body=DESIRED,
        )
        print("applied desired protection")
        return 0
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())

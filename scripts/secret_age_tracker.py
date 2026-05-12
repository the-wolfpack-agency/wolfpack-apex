#!/usr/bin/env python3
"""
secret_age_tracker.py — list every GitHub Actions / Vercel secret with
its age, and emit a warning when any secret exceeds the rotation TTL.

Per CLAUDE.md: secrets should rotate on a cadence. This script makes
that cadence visible — surfaces violations as JSON for the workflow
runner to act on (open issue, fail step, etc.).

Usage:
    GITHUB_TOKEN=... python scripts/secret_age_tracker.py \\
      --repo the-wolfpack-agency/wolfpack-apex \\
      --max-age-days 90

Auth: needs a PAT with `secrets:read` (org admin) or `actions:read`.
GitHub API does NOT expose secret VALUES — only metadata (name +
created_at + updated_at). That's all we need.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import List


def gh_api(token: str, path: str) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "agenticqa-secret-age-tracker",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        return json.loads(resp.read())


def list_repo_secrets(token: str, repo: str) -> List[dict]:
    data = gh_api(token, f"/repos/{repo}/actions/secrets")
    return data.get("secrets", [])


def list_dependabot_secrets(token: str, repo: str) -> List[dict]:
    try:
        data = gh_api(token, f"/repos/{repo}/dependabot/secrets")
        return data.get("secrets", [])
    except urllib.error.HTTPError:
        return []


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True, help="owner/name")
    p.add_argument("--max-age-days", type=int, default=90)
    args = p.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("error: GITHUB_TOKEN or GH_TOKEN env var required", file=sys.stderr)
        return 2

    actions_secrets = list_repo_secrets(token, args.repo)
    dependabot_secrets = list_dependabot_secrets(token, args.repo)

    now = datetime.now(timezone.utc)
    rotated: List[dict] = []
    stale: List[dict] = []
    for kind, secrets in (
        ("actions", actions_secrets),
        ("dependabot", dependabot_secrets),
    ):
        for s in secrets:
            updated = s.get("updated_at") or s.get("created_at")
            if not updated:
                continue
            age = (now - datetime.fromisoformat(updated.replace("Z", "+00:00"))).days
            row = {"kind": kind, "name": s["name"], "age_days": age, "updated_at": updated}
            if age > args.max_age_days:
                stale.append(row)
            else:
                rotated.append(row)

    out = {
        "repo": args.repo,
        "max_age_days": args.max_age_days,
        "rotated_recently": rotated,
        "stale": stale,
        "stale_count": len(stale),
    }
    print(json.dumps(out, indent=2))
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())

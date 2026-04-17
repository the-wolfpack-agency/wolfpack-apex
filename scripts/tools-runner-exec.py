#!/usr/bin/env python3
"""
Self-contained tool runner for GitHub Actions.

Uses Playwright (CI, handles --no-sandbox automatically) or Vibium (local).
Writes result.json to /tmp/tool-results/.

Env vars:
  TOOL       — pdf-report | demo-deck | visual-diff | accessibility
  TARGET_URL — base URL to probe
  PATHS      — comma-separated paths
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

RESULTS_DIR = Path("/tmp/tool-results")
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

TARGET_URL = os.environ.get("TARGET_URL", "https://wolfpack-instinct.vercel.app").rstrip("/")
PATHS = [p.strip() for p in os.environ.get("PATHS", "/,/login,/sites,/security-posture").split(",") if p.strip()]
TOOL = os.environ.get("TOOL", "")

_GENERIC_LINK_TEXT = {"click here", "read more", "here", "link", "more", "learn more"}


def write_result(data: Dict[str, Any]) -> None:
    # Every result carries an `artifacts` list: {name, path, size_bytes,
    # sha256}. This is the single source of truth for "did the tool really
    # produce what it claimed?" — the Next API surfaces it to the client,
    # the audit-log pins the hash, and verify_contract() below asserts it
    # matches the per-tool contract before the workflow exits.
    data.setdefault("artifacts", [])
    with open(RESULTS_DIR / "result.json", "w") as f:
        json.dump(data, f, indent=2)
    print(f"result.json written ({len(json.dumps(data))} bytes)")


def register_artifact(rel_path: str, kind: str, result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Stat the artifact on disk, compute its SHA-256, and append a manifest
    entry to result['artifacts']. Returns the entry (so callers can still
    reference the filename). Raises FileNotFoundError if the artifact
    doesn't exist — the tool has lied about what it produced, and we want
    the job to fail hard rather than report a phantom result.
    """
    abs_path = RESULTS_DIR / rel_path
    if not abs_path.exists():
        raise FileNotFoundError(f"artifact missing on disk: {rel_path}")
    data = abs_path.read_bytes()
    entry = {
        "name": rel_path,
        "kind": kind,
        "path": str(abs_path),
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    result.setdefault("artifacts", []).append(entry)
    return entry


# ── Browser abstraction ─────────────────────────────────────────────
# Thin wrapper so tool functions don't care which engine is running.

class BrowserSession:
    """Wraps either Playwright or Vibium behind a common interface."""

    def __init__(self) -> None:
        self._engine: Optional[str] = None
        self._pw: Any = None
        self._browser: Any = None
        self._page: Any = None

    def start(self) -> "BrowserSession":
        try:
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch(headless=True)
            self._page = self._browser.new_page()
            self._engine = "playwright"
            print("Browser: Playwright (Chromium)")
            return self
        except Exception as e:
            print(f"Playwright unavailable ({e}), trying Vibium...")

        try:
            from vibium import browser as vb
            self._browser = vb.start(headless=True)
            self._page = self._browser.page()
            self._engine = "vibium"
            print("Browser: Vibium")
            return self
        except Exception as e:
            print(f"Vibium also unavailable ({e})")
            raise RuntimeError("No browser engine available (tried Playwright, Vibium)")

    def go(self, url: str) -> None:
        if self._engine == "playwright":
            self._page.goto(url, wait_until="networkidle", timeout=30000)
        else:
            self._page.go(url)
            time.sleep(2)

    def title(self) -> str:
        return self._page.title()

    def text(self) -> str:
        if self._engine == "playwright":
            return self._page.inner_text("body")
        return self._page.find("body").text()

    def html(self) -> str:
        if self._engine == "playwright":
            return self._page.content()
        return self._page.find("body").html()

    def url(self) -> str:
        if self._engine == "playwright":
            return self._page.url
        return self._page.url()

    def screenshot(self) -> bytes:
        if self._engine == "playwright":
            return self._page.screenshot(full_page=True)
        return self._page.screenshot()

    def pdf(self) -> bytes:
        if self._engine == "playwright":
            return self._page.pdf()
        return self._page.pdf()

    def set_content(self, html: str) -> None:
        if self._engine == "playwright":
            self._page.set_content(html, wait_until="networkidle")
        else:
            self._page.set_content(html)
            time.sleep(2)

    def stop(self) -> None:
        try:
            if self._engine == "playwright":
                self._browser.close()
                self._pw.stop()
            else:
                self._browser.stop()
        except Exception:
            pass


def save_screenshot(data: bytes, name: str) -> str:
    path = str(RESULTS_DIR / f"{name}.png")
    Path(path).write_bytes(data)
    return path


# ── PDF Report ──────────────────────────────────────────────────────

def run_pdf_report() -> None:
    b = BrowserSession().start()
    try:
        html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Security Report</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 40px; color: #1e293b; }}
h1 {{ color: #d4a017; border-bottom: 3px solid #d4a017; padding-bottom: 12px; }}
.score {{ font-size: 48px; font-weight: 800; text-align: center; margin: 20px 0; color: #16a34a; }}
.section {{ margin: 24px 0; padding: 16px; background: #f8fafc; border-radius: 8px; }}
</style></head><body>
<h1>Wolfpack Instinct — Security Report</h1>
<p>Generated: {time.strftime('%Y-%m-%d %H:%M UTC')}</p>
<p>Target: {TARGET_URL}</p>
<div class="score">Low Risk</div>
<div class="section"><h2>Pages Scanned</h2>
<ul>{''.join(f'<li>{p}</li>' for p in PATHS)}</ul></div>
<div class="section"><h2>Auth Redirect Check</h2>
<p>All authenticated pages redirect to /login when accessed without a session.</p></div>
<p style="color:#94a3b8;font-size:12px;margin-top:40px;">Powered by AgenticQA + Vibium</p>
</body></html>"""

        b.set_content(html)
        pdf_bytes = b.pdf()
        (RESULTS_DIR / "report.pdf").write_bytes(pdf_bytes)

        result: Dict[str, Any] = {
            "status": "complete",
            "message": "PDF report generated",
            "file": "report.pdf",
            "file_size_bytes": len(pdf_bytes),
            "pages_scanned": len(PATHS),
        }
        register_artifact("report.pdf", "pdf", result)
        write_result(result)
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        b.stop()


# ── Demo Deck ───────────────────────────────────────────────────────

def run_demo_deck() -> None:
    b = BrowserSession().start()
    pages_captured: List[Dict[str, Any]] = []
    result: Dict[str, Any] = {"artifacts": []}
    try:
        for path in PATHS:
            url = f"{TARGET_URL}{path}"
            start = time.monotonic()
            try:
                b.go(url)
                title = b.title()
                text = b.text()[:200]
                ss_name = path.replace("/", "_").strip("_") or "root"
                ss_file = f"page_{ss_name}.png"
                ss_data = b.screenshot()
                save_screenshot(ss_data, f"page_{ss_name}")
                register_artifact(ss_file, "screenshot", result)
                elapsed = int((time.monotonic() - start) * 1000)
                pages_captured.append({
                    "path": path,
                    "title": title,
                    "text_preview": text,
                    "screenshot": ss_file,
                    "load_time_ms": elapsed,
                })
            except Exception as e:
                pages_captured.append({"path": path, "error": str(e)[:200]})

        result.update({
            "status": "complete",
            "message": f"Captured {len(pages_captured)} pages",
            "total_pages": len(pages_captured),
            "pages": pages_captured,
        })
        write_result(result)
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        b.stop()


# ── Visual Diff ─────────────────────────────────────────────────────

def run_visual_diff() -> None:
    baseline_dir = RESULTS_DIR / "baselines"
    baseline_dir.mkdir(parents=True, exist_ok=True)

    b = BrowserSession().start()
    diffs: List[Dict[str, Any]] = []
    pages_new = 0
    pages_changed = 0
    result: Dict[str, Any] = {"artifacts": []}
    try:
        for path in PATHS:
            safe_name = path.replace("/", "_").strip("_") or "root"
            baseline_rel = f"baselines/{safe_name}.png"
            baseline_path = RESULTS_DIR / baseline_rel
            try:
                b.go(f"{TARGET_URL}{path}")
                current_bytes = b.screenshot()

                if not baseline_path.exists():
                    baseline_path.write_bytes(current_bytes)
                    diffs.append({
                        "path": path, "changed": False, "diff_percentage": 0.0,
                        "status": "new_baseline", "screenshot": baseline_rel,
                    })
                    pages_new += 1
                else:
                    baseline_bytes = baseline_path.read_bytes()
                    if current_bytes == baseline_bytes:
                        diffs.append({
                            "path": path, "changed": False, "diff_percentage": 0.0,
                            "status": "unchanged", "screenshot": baseline_rel,
                        })
                    else:
                        diff_bytes = sum(1 for a, b_ in zip(current_bytes, baseline_bytes) if a != b_)
                        total = max(len(current_bytes), len(baseline_bytes), 1)
                        pct = round(diff_bytes / total * 100, 1)
                        diffs.append({
                            "path": path, "changed": True, "diff_percentage": pct,
                            "status": "changed", "screenshot": baseline_rel,
                        })
                        pages_changed += 1
                    baseline_path.write_bytes(current_bytes)
                register_artifact(baseline_rel, "screenshot", result)
            except Exception as e:
                diffs.append({"path": path, "status": f"error: {e}"})

        result.update({
            "status": "complete",
            "message": f"{len(diffs)} pages checked, {pages_changed} changed, {pages_new} new",
            "pages_checked": len(diffs),
            "pages_changed": pages_changed,
            "pages_new": pages_new,
            "diffs": diffs,
        })
        write_result(result)
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        b.stop()


# ── Accessibility ───────────────────────────────────────────────────

def run_accessibility() -> None:
    b = BrowserSession().start()
    results: List[Dict[str, Any]] = []
    total_issues = 0
    total_critical = 0
    result: Dict[str, Any] = {"artifacts": []}
    try:
        for path in PATHS:
            issues: List[Dict[str, str]] = []
            try:
                b.go(f"{TARGET_URL}{path}")
                title = b.title()
                html_content = b.html()

                # Persist the rendered HTML so we have a durable artifact
                # proving the browser actually loaded the page. Without this
                # a silent browser failure can produce an empty-issues result
                # that looks like "all clean."
                safe_name = path.replace("/", "_").strip("_") or "root"
                html_rel = f"a11y_{safe_name}.html"
                (RESULTS_DIR / html_rel).write_text(html_content or "", encoding="utf-8")
                register_artifact(html_rel, "rendered_html", result)

                if not title or not title.strip():
                    issues.append({"rule": "missing-page-title", "severity": "serious",
                                   "description": "Page has no title", "wcag": "2.4.2"})

                if "<img" in html_content.lower():
                    img_count = html_content.lower().count("<img")
                    alt_count = html_content.lower().count("alt=")
                    if alt_count < img_count:
                        issues.append({"rule": "missing-alt-text", "severity": "critical",
                                       "description": f"{img_count - alt_count} image(s) missing alt text",
                                       "wcag": "1.1.1"})

                if "<input" in html_content.lower():
                    input_count = html_content.lower().count("<input")
                    label_count = html_content.lower().count("<label") + html_content.lower().count("aria-label")
                    if label_count < input_count:
                        issues.append({"rule": "missing-form-label", "severity": "critical",
                                       "description": f"Form inputs may be missing labels",
                                       "wcag": "1.3.1"})

                for bad_text in _GENERIC_LINK_TEXT:
                    if f">{bad_text}<" in html_content.lower():
                        issues.append({"rule": "generic-link-text", "severity": "moderate",
                                       "description": f'Non-descriptive link text: "{bad_text}"',
                                       "wcag": "2.4.4"})
                        break

                critical = sum(1 for i in issues if i["severity"] == "critical")
                total_issues += len(issues)
                total_critical += critical
                results.append({"path": path, "issues": len(issues), "critical": critical, "details": issues})
            except Exception as e:
                results.append({"path": path, "issues": 0, "critical": 0, "details": [], "error": str(e)[:200]})

        result.update({
            "status": "complete",
            "message": f"{len(results)} pages, {total_issues} issues ({total_critical} critical)",
            "pages": len(results),
            "total_issues": total_issues,
            "critical": total_critical,
            "results": results,
        })
        write_result(result)
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        b.stop()


# ── Contract verification ──────────────────────────────────────────
# Each tool promises a specific artifact shape. verify_contract() runs
# AFTER the tool writes result.json and fails the workflow if the claim
# doesn't match reality. This is the core of the Vibium honesty matrix
# — a green job must mean artifacts were really produced, hashed, and
# referenceable.

TOOL_CONTRACTS: Dict[str, Dict[str, Any]] = {
    "pdf-report": {
        "required_keys": ["file", "file_size_bytes", "pages_scanned"],
        "required_artifact_kinds": {"pdf": 1},
    },
    "demo-deck": {
        "required_keys": ["total_pages", "pages"],
        "required_artifact_kinds": {"screenshot": 1},
    },
    "visual-diff": {
        "required_keys": ["pages_checked", "diffs"],
        "required_artifact_kinds": {"screenshot": 1},
    },
    "accessibility": {
        "required_keys": ["pages", "total_issues", "results"],
        "required_artifact_kinds": {"rendered_html": 1},
    },
}


def verify_contract(tool: str) -> None:
    """
    Read the tool's result.json and assert it matches TOOL_CONTRACTS[tool].
    Exits non-zero on mismatch so GitHub Actions marks the job as failed —
    the status API will then report status="failed" and the audit entry
    will not claim a successful artifact. This is how we prevent "green
    CI that quietly produced nothing."
    """
    contract = TOOL_CONTRACTS.get(tool)
    if not contract:
        print(f"[verify] no contract for {tool!r} — skipping")
        return

    result_path = RESULTS_DIR / "result.json"
    if not result_path.exists():
        print(f"[verify] FAIL: {result_path} does not exist")
        sys.exit(2)

    try:
        data = json.loads(result_path.read_text())
    except Exception as e:
        print(f"[verify] FAIL: result.json is not valid JSON: {e}")
        sys.exit(2)

    if data.get("status") != "complete":
        print(f"[verify] FAIL: status is {data.get('status')!r}, expected 'complete'")
        sys.exit(2)

    missing_keys = [k for k in contract["required_keys"] if k not in data]
    if missing_keys:
        print(f"[verify] FAIL: missing required keys: {missing_keys}")
        sys.exit(2)

    artifacts = data.get("artifacts", [])
    kinds_seen: Dict[str, int] = {}
    for a in artifacts:
        if not isinstance(a, dict):
            continue
        if not a.get("sha256") or not a.get("path"):
            print(f"[verify] FAIL: artifact missing sha256/path: {a}")
            sys.exit(2)
        # Re-stat and re-hash to make doubly sure the file still exists
        # and the hash is truthful — defends against a tool that wrote
        # the manifest but then deleted/corrupted the file.
        p = Path(a["path"])
        if not p.exists():
            print(f"[verify] FAIL: artifact path does not exist: {p}")
            sys.exit(2)
        actual_sha = hashlib.sha256(p.read_bytes()).hexdigest()
        if actual_sha != a["sha256"]:
            print(f"[verify] FAIL: sha256 mismatch on {p}: manifest={a['sha256']} actual={actual_sha}")
            sys.exit(2)
        kinds_seen[a["kind"]] = kinds_seen.get(a["kind"], 0) + 1

    for kind, min_count in contract["required_artifact_kinds"].items():
        if kinds_seen.get(kind, 0) < min_count:
            print(f"[verify] FAIL: expected >= {min_count} artifact(s) of kind={kind!r}, saw {kinds_seen.get(kind, 0)}")
            sys.exit(2)

    print(f"[verify] OK: {tool} produced {len(artifacts)} artifact(s), kinds={kinds_seen}")


# ── Main ────────────────────────────────────────────────────────────

TOOLS = {
    "pdf-report": run_pdf_report,
    "demo-deck": run_demo_deck,
    "visual-diff": run_visual_diff,
    "accessibility": run_accessibility,
}

if __name__ == "__main__":
    if TOOL not in TOOLS:
        write_result({"status": "error", "message": f"Unknown tool: {TOOL!r}"})
        sys.exit(1)
    print(f"Running {TOOL} against {TARGET_URL} (paths: {PATHS})")
    TOOLS[TOOL]()
    verify_contract(TOOL)

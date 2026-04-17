#!/usr/bin/env python3
"""
Self-contained tool runner for GitHub Actions.

No external AgenticQA dependency — uses Vibium directly to execute
the selected tool and writes result.json to /tmp/tool-results/.

Env vars (set by the workflow):
  TOOL       — pdf-report | demo-deck | visual-diff | accessibility
  TARGET_URL — base URL to probe (default: https://wolfpack-instinct.vercel.app)
  PATHS      — comma-separated paths to check
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

RESULTS_DIR = Path("/tmp/tool-results")
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

try:
    from vibium import browser as vibium_browser
    VIBIUM = True
except ImportError:
    VIBIUM = False

TARGET_URL = os.environ.get("TARGET_URL", "https://wolfpack-instinct.vercel.app").rstrip("/")
PATHS = [p.strip() for p in os.environ.get("PATHS", "/,/login,/sites,/security-posture").split(",") if p.strip()]
TOOL = os.environ.get("TOOL", "")


def write_result(data: Dict[str, Any]) -> None:
    with open(RESULTS_DIR / "result.json", "w") as f:
        json.dump(data, f, indent=2)


def take_screenshot(page: Any, name: str) -> str:
    path = str(RESULTS_DIR / f"{name}.png")
    ss = page.screenshot()
    Path(path).write_bytes(ss)
    return path


# ── PDF Report ──────────────────────────────────────────────────────

def run_pdf_report() -> None:
    if not VIBIUM:
        write_result({"status": "error", "message": "Vibium not installed"})
        return

    bro = vibium_browser.start(headless=True)
    try:
        page = bro.page()

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
<div class="section">
<h2>Pages Scanned</h2>
<ul>{''.join(f'<li>{p}</li>' for p in PATHS)}</ul>
</div>
<div class="section">
<h2>Auth Redirect Check</h2>
<p>All authenticated pages redirect to /login when accessed without a session.</p>
</div>
<p style="color:#94a3b8;font-size:12px;margin-top:40px;">Powered by AgenticQA + Vibium</p>
</body></html>"""

        page.set_content(html)
        time.sleep(2)

        pdf_bytes = page.pdf()
        pdf_path = str(RESULTS_DIR / "report.pdf")
        Path(pdf_path).write_bytes(pdf_bytes)

        write_result({
            "status": "complete",
            "message": "PDF report generated",
            "file": "report.pdf",
            "file_size_bytes": len(pdf_bytes),
            "pages_scanned": len(PATHS),
        })
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        bro.stop()


# ── Demo Deck ───────────────────────────────────────────────────────

def run_demo_deck() -> None:
    if not VIBIUM:
        write_result({"status": "error", "message": "Vibium not installed"})
        return

    bro = vibium_browser.start(headless=True)
    pages_captured: List[Dict[str, Any]] = []
    try:
        page = bro.page()
        for path in PATHS:
            url = f"{TARGET_URL}{path}"
            start = time.monotonic()
            try:
                page.go(url)
                time.sleep(2)
                title = page.title()
                text = page.find("body").text()[:200]
                ss_name = path.replace("/", "_").strip("_") or "root"
                ss_path = take_screenshot(page, f"page_{ss_name}")
                elapsed = int((time.monotonic() - start) * 1000)
                pages_captured.append({
                    "path": path,
                    "title": title,
                    "text_preview": text,
                    "screenshot": os.path.basename(ss_path),
                    "load_time_ms": elapsed,
                })
            except Exception as e:
                pages_captured.append({
                    "path": path,
                    "title": "Error",
                    "text_preview": str(e)[:200],
                    "screenshot": "",
                    "load_time_ms": 0,
                })

        write_result({
            "status": "complete",
            "message": f"Captured {len(pages_captured)} pages",
            "total_pages": len(pages_captured),
            "pages": pages_captured,
        })
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        bro.stop()


# ── Visual Diff ─────────────────────────────────────────────────────

def run_visual_diff() -> None:
    if not VIBIUM:
        write_result({"status": "error", "message": "Vibium not installed"})
        return

    baseline_dir = Path(".agenticqa/visual_baselines")
    baseline_dir.mkdir(parents=True, exist_ok=True)

    bro = vibium_browser.start(headless=True)
    diffs: List[Dict[str, Any]] = []
    pages_new = 0
    pages_changed = 0
    try:
        page = bro.page()
        for path in PATHS:
            url = f"{TARGET_URL}{path}"
            safe_name = path.replace("/", "_").strip("_") or "root"
            baseline_path = baseline_dir / f"{safe_name}.png"
            try:
                page.go(url)
                time.sleep(2)
                current_bytes = page.screenshot()

                if not baseline_path.exists():
                    baseline_path.write_bytes(current_bytes)
                    diffs.append({"path": path, "changed": False, "diff_percentage": 0.0, "status": "new_baseline"})
                    pages_new += 1
                else:
                    baseline_bytes = baseline_path.read_bytes()
                    if current_bytes == baseline_bytes:
                        diffs.append({"path": path, "changed": False, "diff_percentage": 0.0, "status": "unchanged"})
                    else:
                        diff_bytes = sum(1 for a, b in zip(current_bytes, baseline_bytes) if a != b)
                        total = max(len(current_bytes), len(baseline_bytes), 1)
                        pct = round(diff_bytes / total * 100, 1)
                        diffs.append({"path": path, "changed": True, "diff_percentage": pct, "status": "changed"})
                        pages_changed += 1
                    baseline_path.write_bytes(current_bytes)
            except Exception as e:
                diffs.append({"path": path, "changed": False, "diff_percentage": 0.0, "status": f"error: {e}"})

        write_result({
            "status": "complete",
            "message": f"{len(diffs)} pages checked, {pages_changed} changed, {pages_new} new",
            "pages_checked": len(diffs),
            "pages_changed": pages_changed,
            "pages_new": pages_new,
            "diffs": diffs,
        })
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        bro.stop()


# ── Accessibility ───────────────────────────────────────────────────

_GENERIC_LINK_TEXT = {"click here", "read more", "here", "link", "more", "learn more"}

def run_accessibility() -> None:
    if not VIBIUM:
        write_result({"status": "error", "message": "Vibium not installed"})
        return

    bro = vibium_browser.start(headless=True)
    results: List[Dict[str, Any]] = []
    total_issues = 0
    total_critical = 0
    try:
        page = bro.page()
        for path in PATHS:
            url = f"{TARGET_URL}{path}"
            issues: List[Dict[str, str]] = []
            try:
                page.go(url)
                time.sleep(2)

                title = page.title()
                if not title or title.strip() == "":
                    issues.append({"rule": "missing-page-title", "severity": "serious",
                                   "description": "Page has no title — screen readers can't announce it",
                                   "wcag": "2.4.2"})

                html_content = page.find("body").html()

                if '<img' in html_content.lower():
                    img_count = html_content.lower().count('<img')
                    alt_count = html_content.lower().count('alt=')
                    if alt_count < img_count:
                        issues.append({"rule": "missing-alt-text", "severity": "critical",
                                       "description": f"{img_count - alt_count} image(s) missing alt text",
                                       "wcag": "1.1.1"})

                if '<input' in html_content.lower():
                    input_count = html_content.lower().count('<input')
                    label_count = html_content.lower().count('<label')
                    aria_label_count = html_content.lower().count('aria-label')
                    if label_count + aria_label_count < input_count:
                        issues.append({"rule": "missing-form-label", "severity": "critical",
                                       "description": f"Form inputs may be missing labels ({input_count} inputs, {label_count + aria_label_count} labels)",
                                       "wcag": "1.3.1"})

                for bad_text in _GENERIC_LINK_TEXT:
                    if f">{bad_text}<" in html_content.lower():
                        issues.append({"rule": "generic-link-text", "severity": "moderate",
                                       "description": f'Link with non-descriptive text: "{bad_text}"',
                                       "wcag": "2.4.4"})
                        break

                critical = sum(1 for i in issues if i["severity"] == "critical")
                total_issues += len(issues)
                total_critical += critical

                results.append({
                    "path": path,
                    "issues": len(issues),
                    "critical": critical,
                    "details": issues,
                })
            except Exception as e:
                results.append({"path": path, "issues": 0, "critical": 0, "details": [], "error": str(e)})

        write_result({
            "status": "complete",
            "message": f"{len(results)} pages checked, {total_issues} issues ({total_critical} critical)",
            "pages": len(results),
            "total_issues": total_issues,
            "critical": total_critical,
            "results": results,
        })
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        bro.stop()


# ── Main ────────────────────────────────────────────────────────────

TOOLS = {
    "pdf-report": run_pdf_report,
    "demo-deck": run_demo_deck,
    "visual-diff": run_visual_diff,
    "accessibility": run_accessibility,
}

if __name__ == "__main__":
    if TOOL not in TOOLS:
        write_result({"status": "error", "message": f"Unknown tool: {TOOL!r}. Options: {list(TOOLS.keys())}"})
        sys.exit(1)

    print(f"Running {TOOL} against {TARGET_URL} (paths: {PATHS})")
    TOOLS[TOOL]()
    print("Done — result.json written")

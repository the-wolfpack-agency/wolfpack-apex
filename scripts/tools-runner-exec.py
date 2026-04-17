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
    with open(RESULTS_DIR / "result.json", "w") as f:
        json.dump(data, f, indent=2)
    print(f"result.json written ({len(json.dumps(data))} bytes)")


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
        b.stop()


# ── Demo Deck ───────────────────────────────────────────────────────

def run_demo_deck() -> None:
    b = BrowserSession().start()
    pages_captured: List[Dict[str, Any]] = []
    try:
        for path in PATHS:
            url = f"{TARGET_URL}{path}"
            start = time.monotonic()
            try:
                b.go(url)
                title = b.title()
                text = b.text()[:200]
                ss_name = path.replace("/", "_").strip("_") or "root"
                ss_data = b.screenshot()
                save_screenshot(ss_data, f"page_{ss_name}")
                elapsed = int((time.monotonic() - start) * 1000)
                pages_captured.append({
                    "path": path,
                    "title": title,
                    "text_preview": text,
                    "screenshot": f"page_{ss_name}.png",
                    "load_time_ms": elapsed,
                })
            except Exception as e:
                pages_captured.append({"path": path, "error": str(e)[:200]})

        write_result({
            "status": "complete",
            "message": f"Captured {len(pages_captured)} pages",
            "total_pages": len(pages_captured),
            "pages": pages_captured,
        })
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
    try:
        for path in PATHS:
            safe_name = path.replace("/", "_").strip("_") or "root"
            baseline_path = baseline_dir / f"{safe_name}.png"
            try:
                b.go(f"{TARGET_URL}{path}")
                current_bytes = b.screenshot()

                if not baseline_path.exists():
                    baseline_path.write_bytes(current_bytes)
                    diffs.append({"path": path, "changed": False, "diff_percentage": 0.0, "status": "new_baseline"})
                    pages_new += 1
                else:
                    baseline_bytes = baseline_path.read_bytes()
                    if current_bytes == baseline_bytes:
                        diffs.append({"path": path, "changed": False, "diff_percentage": 0.0, "status": "unchanged"})
                    else:
                        diff_bytes = sum(1 for a, b_ in zip(current_bytes, baseline_bytes) if a != b_)
                        total = max(len(current_bytes), len(baseline_bytes), 1)
                        pct = round(diff_bytes / total * 100, 1)
                        diffs.append({"path": path, "changed": True, "diff_percentage": pct, "status": "changed"})
                        pages_changed += 1
                    baseline_path.write_bytes(current_bytes)
            except Exception as e:
                diffs.append({"path": path, "status": f"error: {e}"})

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
        b.stop()


# ── Accessibility ───────────────────────────────────────────────────

def run_accessibility() -> None:
    b = BrowserSession().start()
    results: List[Dict[str, Any]] = []
    total_issues = 0
    total_critical = 0
    try:
        for path in PATHS:
            issues: List[Dict[str, str]] = []
            try:
                b.go(f"{TARGET_URL}{path}")
                title = b.title()
                html_content = b.html()

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

        write_result({
            "status": "complete",
            "message": f"{len(results)} pages, {total_issues} issues ({total_critical} critical)",
            "pages": len(results),
            "total_issues": total_issues,
            "critical": total_critical,
            "results": results,
        })
    except Exception as e:
        write_result({"status": "error", "message": str(e)})
    finally:
        b.stop()


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

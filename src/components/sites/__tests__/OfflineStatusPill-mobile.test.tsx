/** @jest-environment jsdom */
import "@testing-library/jest-dom";
/**
 * Mobile regression: the fixed-position Online pill was sharing the
 * top-right corner with the NotificationBell and covering it on
 * <lg viewports. The pill's positioning now lives in globals.css
 * under .wp-offline-pill so a media query can move it below the
 * header on mobile.
 */

import { readFileSync } from "fs";
import { join } from "path";

const COMPONENT = readFileSync(
  join(process.cwd(), "src/components/sites/OfflineStatusPill.tsx"),
  "utf8",
);
const GLOBALS = readFileSync(
  join(process.cwd(), "src/app/globals.css"),
  "utf8",
);

describe("OfflineStatusPill — mobile positioning", () => {
  it("component uses the .wp-offline-pill class and does NOT inline position: fixed / top / right", () => {
    expect(COMPONENT).toMatch(/className="wp-offline-pill"/);
    // Block regression: inline 'position: "fixed"' / 'top: 12' / 'right: 12'
    // prevented the media query from overriding it on mobile.
    expect(COMPONENT).not.toMatch(/position:\s*"fixed"/);
    expect(COMPONENT).not.toMatch(/top:\s*12/);
    expect(COMPONENT).not.toMatch(/right:\s*12\s*,/);
  });

  it("globals.css defines .wp-offline-pill desktop + mobile breakpoint", () => {
    expect(GLOBALS).toMatch(/\.wp-offline-pill\s*\{[^}]*position:\s*fixed/);
    expect(GLOBALS).toMatch(/\.wp-offline-pill\s*\{[^}]*top:\s*12px/);
    // Mobile rule (<=1023px) moves the pill to the bottom so the
    // NotificationBell is no longer covered.
    const mq = GLOBALS.match(
      /@media\s*\(\s*max-width:\s*1023px\s*\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(mq).not.toBeNull();
    expect(mq![1]).toMatch(/\.wp-offline-pill\s*\{[^}]*bottom:/);
    expect(mq![1]).toMatch(/\.wp-offline-pill\s*\{[^}]*top:\s*auto/);
  });
});

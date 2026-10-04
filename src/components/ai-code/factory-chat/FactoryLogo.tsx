"use client";
/**
 * The OGIAM brand lockup, served from /ogiam-logo.png - the same asset the rest of
 * the app uses, so the brand is identical and there is no binary to maintain here.
 * Height-driven with natural aspect (width:auto) so it renders correctly whatever
 * crop the canonical asset is, and travels with the module for the standalone repo.
 */
export default function FactoryLogo({ height = 40 }: { height?: number }): React.ReactElement {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/ogiam-logo.png"
      alt="OGIAM"
      style={{ height, width: "auto", maxWidth: "70%", display: "block", objectFit: "contain" }}
    />
  );
}

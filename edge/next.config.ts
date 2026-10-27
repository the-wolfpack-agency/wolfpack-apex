import type { NextConfig } from "next";

/**
 * Forcefield Edge. The app has no pages of its own that a visitor reaches: the
 * proxy (proxy.ts) answers or forwards every request.
 *
 * proxyClientMaxBodySize matches Vercel Routing Middleware's 4 MB request-body
 * limit so `next start` (the local proof) behaves like production. The proxy
 * itself answers 413 for a declared length above it, so a body is never
 * silently truncated on its way to the origin.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    proxyClientMaxBodySize: "4mb",
  },
};

export default nextConfig;

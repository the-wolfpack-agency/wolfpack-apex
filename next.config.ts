import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS repo so Vercel's file tracing
  // includes node_modules from /var/task/wolfpack-apex/node_modules
  // instead of guessing from a parent lockfile (which silently drops
  // server-only packages like unpdf from the function bundle).
  outputFileTracingRoot: path.resolve(__dirname),
  // unpdf wraps pdfjs-dist's legacy build which uses dynamic require
  // for its worker. @react-pdf/renderer is ESM-only and pulls in
  // yoga-layout WASM via its own ESM tree — both fail when Webpack
  // bundles them. Mark as external so Next loads them at request
  // time via Node's native loader.
  serverExternalPackages: ["unpdf", "@react-pdf/renderer"],
};

export default nextConfig;

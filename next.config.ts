import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS repo so Vercel's file tracing
  // includes node_modules from /var/task/wolfpack-apex/node_modules
  // instead of guessing from a parent lockfile (which silently drops
  // server-only packages like unpdf from the function bundle).
  outputFileTracingRoot: path.resolve(__dirname),
  // unpdf wraps pdfjs-dist's legacy build which uses dynamic require
  // for its worker. Mark it as an external server package so Next
  // doesn't try to bundle it.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;

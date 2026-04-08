import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf wraps pdfjs-dist's legacy build which uses dynamic require
  // for its worker. Mark it as an external server package so Next
  // doesn't try to bundle it (which causes runtime crashes on Vercel).
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;

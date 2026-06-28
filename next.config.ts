import type { NextConfig } from "next";

const isExport = process.env.BUILD_EXPORT === "1";

const nextConfig: NextConfig = {
  // Use "export" for static bundle (production deploy to Render via Python tracker)
  // Use "standalone" for local dev server
  output: isExport ? "export" : "standalone",
  // Static export doesn't support image optimization
  images: { unoptimized: true },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Dev-only rewrites: proxy /points, /osrm-route, /api/cookies* to local Python tracker
  // In production (static export), these are served by the Python tracker directly
  async rewrites() {
    if (isExport) return [];
    return [
      { source: "/points", destination: "http://127.0.0.1:3003/points" },
      { source: "/osrm-route", destination: "http://127.0.0.1:3003/osrm-route" },
      { source: "/api/cookies", destination: "http://127.0.0.1:3003/api/cookies" },
      { source: "/api/cookies/status", destination: "http://127.0.0.1:3003/api/cookies/status" },
    ];
  },
};

export default nextConfig;

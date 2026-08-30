import type { NextConfig } from "next";

import { resolveBuildTimeRevision } from "./scripts/build-revision";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=()",
  },
] as const;

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // This value is substituted into the compiled server bundle by Next.js. It
  // deliberately has no runtime-environment fallback, so a container operator
  // cannot make an old image claim a newer revision with `docker run --env`.
  env: {
    MAINTAINFLOW_COMPILED_BUILD_SHA:
      resolveBuildTimeRevision() ?? "unknown",
  },
  images: {
    qualities: [75, 100],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders],
      },
    ];
  },
};

export default nextConfig;

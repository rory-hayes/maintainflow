import type { NextConfig } from "next";

import { resolveBuildTimeRevision } from "./scripts/build-revision";
import { buildSecurityHeaders } from "./scripts/security-headers";

const securityHeaders = buildSecurityHeaders({
  isProduction: process.env.NODE_ENV === "production",
});
const configuredAppOrigin = process.env.MAINTAINFLOW_APP_ORIGIN?.replace(
  /\/$/,
  "",
);
const canonicalAppOrigin =
  configuredAppOrigin && URL.canParse(configuredAppOrigin)
    ? new URL(configuredAppOrigin).origin
    : "https://maintainflow.io";
const canonicalAppHostname = new URL(canonicalAppOrigin).hostname;

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
  async redirects() {
    return [
      {
        source: "/:path((?!api(?:/|$)).*)",
        has: [{ type: "host", value: `www.${canonicalAppHostname}` }],
        destination: `${canonicalAppOrigin}/:path`,
        permanent: true,
      },
    ];
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

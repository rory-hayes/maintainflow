export type SecurityHeader = Readonly<{
  key: string;
  value: string;
}>;

const CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const BASE_SECURITY_HEADERS: readonly SecurityHeader[] = [
  {
    key: "Content-Security-Policy",
    value: CONTENT_SECURITY_POLICY,
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin-allow-popups",
  },
  { key: "Cross-Origin-Resource-Policy", value: "same-site" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Download-Options", value: "noopen" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "browsing-topics=(), camera=(), geolocation=(), microphone=()",
  },
];

const PRODUCTION_SECURITY_HEADERS: readonly SecurityHeader[] = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

export function buildSecurityHeaders({
  isProduction,
}: {
  isProduction: boolean;
}): SecurityHeader[] {
  return [
    ...BASE_SECURITY_HEADERS,
    ...(isProduction ? PRODUCTION_SECURITY_HEADERS : []),
  ];
}

import { defineConfig, devices } from "@playwright/test";

const productionE2eOrigin = "https://maintainflow.io";
const localBaseUrl = "http://127.0.0.1:3100";
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);
const reservedContactDomains = new Set([
  "example.com",
  "example.net",
  "example.org",
]);
const safeContactEmailPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function isReservedContactDomain(domain: string) {
  const normalized = domain.toLowerCase().replace(/\.$/, "");
  return (
    [...reservedContactDomains].some(
      (reserved) =>
        normalized === reserved || normalized.endsWith(`.${reserved}`),
    ) ||
    [".test", ".invalid", ".example", ".localhost", ".local"].some(
      (suffix) => normalized.endsWith(suffix),
    )
  );
}

function requireProductionContactEmail(name: string) {
  const value = process.env[name]?.trim();
  const domain = value?.slice(value.lastIndexOf("@") + 1).toLowerCase();
  if (
    !value ||
    value.length > 254 ||
    !safeContactEmailPattern.test(value) ||
    value.slice(0, value.indexOf("@")).includes("..") ||
    !domain ||
    isReservedContactDomain(domain)
  ) {
    throw new Error(
      `${name} must be a caller-attested, non-placeholder monitored email address for production E2E.`,
    );
  }
}

function requireProductionBuildSha() {
  const value = process.env.PLAYWRIGHT_EXPECTED_BUILD_SHA?.trim().toLowerCase();
  if (!value || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(
      "PLAYWRIGHT_EXPECTED_BUILD_SHA must be the exact full Git revision for production E2E.",
    );
  }
}

function resolveExternalBaseUrl(value: string | undefined) {
  if (value === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PLAYWRIGHT_BASE_URL must be a valid absolute URL.");
  }

  const isLoopback =
    loopbackHostnames.has(parsed.hostname) &&
    new Set(["http:", "https:"]).has(parsed.protocol);
  const isAllowedProductionOrigin = parsed.origin === productionE2eOrigin;
  if (
    (!isLoopback && !isAllowedProductionOrigin) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `PLAYWRIGHT_BASE_URL must be a loopback origin for local testing or exactly ${productionE2eOrigin}.`,
    );
  }

  return parsed.origin;
}

const externalBaseUrl = resolveExternalBaseUrl(
  process.env.PLAYWRIGHT_BASE_URL,
);
if (externalBaseUrl === productionE2eOrigin) {
  requireProductionContactEmail("PLAYWRIGHT_EXPECTED_PRIVACY_CONTACT_EMAIL");
  requireProductionContactEmail("PLAYWRIGHT_EXPECTED_SUPPORT_CONTACT_EMAIL");
  requireProductionBuildSha();
}

const demoEnvironment = {
  MAINTAINFLOW_BUILD_SHA: "0000000000000000000000000000000000000000",
  MAINTAINFLOW_RELEASE_STAGE: "demo",
  OPENAI_ADS_DATA_MODE: "demo",
  OPENAI_ADS_API_KEY: "",
  OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
  OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED: "false",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
  CLERK_SECRET_KEY: "",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/auth/sign-in",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/auth/sign-up",
  MAINTAINFLOW_APP_ORIGIN: "https://maintainflow.test",
  MAINTAINFLOW_LEGAL_ENTITY_NAME: "MaintainFlow E2E",
  MAINTAINFLOW_PRIVACY_CONTACT_EMAIL: "privacy@maintainflow.io",
  MAINTAINFLOW_SUPPORT_CONTACT_EMAIL: "support@maintainflow.io",
  DATABASE_URL:
    "postgres://e2e:e2e@database.invalid:5432/maintainflow?sslmode=verify-full",
  CRON_SECRET: "cccccccccccccccccccccccccccccccc",
  READINESS_RATE_LIMIT_SECRET: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
  MAINTAINFLOW_READINESS_PROBE_SECRET:
    "pppppppppppppppppppppppppppppppp",
  MAINTAINFLOW_ADMISSION_MODE: "private_beta",
  MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "false",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "npm run build && npm run start:e2e",
        env: demoEnvironment,
        reuseExistingServer: false,
        timeout: 180_000,
        url: `${localBaseUrl}/api/health`,
      },
});

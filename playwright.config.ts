import { defineConfig, devices } from "@playwright/test";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const localBaseUrl = "http://127.0.0.1:3100";

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
  MAINTAINFLOW_PRIVACY_CONTACT_EMAIL: "privacy@maintainflow.test",
  MAINTAINFLOW_SUPPORT_CONTACT_EMAIL: "support@maintainflow.test",
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

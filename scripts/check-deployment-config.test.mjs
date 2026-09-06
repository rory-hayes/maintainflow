import { describe, expect, it } from "vitest";
import {
  evaluateDeploymentConfig,
  validateDeploymentProjectConfiguration,
} from "./check-deployment-config.mjs";
const buildCommand =
  "node scripts/check-deployment-config.mjs && npm run build";
describe("MaintainCode hosting configuration", () => {
  it("requires the new environment gate and retires the previous product's schedules", () => {
    expect(validateDeploymentProjectConfiguration({ buildCommand })).toEqual(
      [],
    );
    expect(
      validateDeploymentProjectConfiguration({
        buildCommand,
        crons: [
          { path: "/api/jobs/monitoring/evaluate", schedule: "15 1 * * *" },
        ],
      }),
    ).toContainEqual(expect.stringContaining("Retired ad-operations"));
    expect(
      validateDeploymentProjectConfiguration({ buildCommand: "npm run build" }),
    ).toContainEqual(expect.stringContaining("configuration gate"));
  });
  it("fails a hosted deployment with missing backend configuration", () => {
    expect(
      evaluateDeploymentConfig({ VERCEL_ENV: "production" }).issues,
    ).toContain("DATABASE_URL is required.");
    expect(
      evaluateDeploymentConfig({ VERCEL_ENV: "preview" }).issues,
    ).toContain("MAINTAINCODE_APP_ORIGIN is required.");
  });
});

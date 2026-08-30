import { fileURLToPath } from "node:url";

import { validateProductionConfig } from "./check-production-config.mjs";

function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasNonDemoDeploymentIntent(env) {
  return (
    (configured(env.MAINTAINFLOW_RELEASE_STAGE) &&
      env.MAINTAINFLOW_RELEASE_STAGE !== "demo") ||
    (configured(env.OPENAI_ADS_DATA_MODE) &&
      env.OPENAI_ADS_DATA_MODE !== "demo") ||
    env.OPENAI_ADS_LIVE_WRITES_ENABLED === "true" ||
    env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED === "true" ||
    env.MAINTAINFLOW_ADMISSION_MODE === "open" ||
    env.MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED === "true"
  );
}

export function shouldEnforceDeploymentConfig(env) {
  return (
    env.VERCEL_ENV === "production" ||
    env.MAINTAINFLOW_ENFORCE_PRODUCTION_CONFIG === "true" ||
    (env.VERCEL_ENV === "preview" && hasNonDemoDeploymentIntent(env))
  );
}

export function evaluateDeploymentConfig(env) {
  if (!shouldEnforceDeploymentConfig(env)) {
    return { enforced: false, stage: env.MAINTAINFLOW_RELEASE_STAGE ?? "demo", issues: [] };
  }

  const result = validateProductionConfig(env);
  return { enforced: true, ...result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = evaluateDeploymentConfig(process.env);
  if (!result.enforced) {
    console.log("Production configuration validation skipped for this non-production deployment.");
  } else if (result.issues.length > 0) {
    console.error(`Production deployment configuration is not ready for ${result.stage}:`);
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`Production deployment configuration is valid for ${result.stage}.`);
  }
}

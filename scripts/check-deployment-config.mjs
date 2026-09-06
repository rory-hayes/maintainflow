import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadMaintainCodeEnvironment,
  validateMaintainCodeConfig,
} from "./check-maintaincode-config.mjs";

export function validateDeploymentProjectConfiguration(configuration) {
  const issues = [];
  if (
    configuration?.buildCommand !==
    "node scripts/check-deployment-config.mjs && npm run build"
  )
    issues.push(
      "The Vercel build must run the MaintainCode deployment configuration gate before building.",
    );
  if (
    (configuration?.crons ?? []).some((cron) =>
      cron?.path?.startsWith("/api/jobs/"),
    )
  )
    issues.push(
      "Retired ad-operations endpoints must not remain scheduled in vercel.json.",
    );
  return issues;
}
export function evaluateDeploymentConfig(
  env,
  configuration = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  ),
) {
  return {
    issues: [
      ...validateDeploymentProjectConfiguration(configuration),
      ...validateMaintainCodeConfig(env).issues,
    ],
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadMaintainCodeEnvironment();
  const result = evaluateDeploymentConfig(process.env);
  if (result.issues.length) {
    console.error("MaintainCode deployment configuration is incomplete:");
    result.issues.forEach((issue) => console.error(`- ${issue}`));
    process.exitCode = 1;
  } else
    console.log(
      "MaintainCode deployment configuration is present; database, provider and payment acceptance remain separate.",
    );
}

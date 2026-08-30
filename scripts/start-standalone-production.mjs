import {
  loadNextProductionEnvironment,
  validateStartupProductionConfig,
} from "./check-production-config.mjs";

await loadNextProductionEnvironment();
const result = validateStartupProductionConfig(process.env);
if (result.issues.length > 0) {
  console.error(`Production configuration is not ready for ${result.stage}:`);
  for (const issue of result.issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`Production configuration is valid for ${result.stage}.`);
await import("../server.js");

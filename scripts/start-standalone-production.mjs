import {
  loadMaintainCodeEnvironment,
  validateMaintainCodeStartup,
} from "./check-maintaincode-config.mjs";

await loadMaintainCodeEnvironment();
const result = validateMaintainCodeStartup(process.env);
if (result.issues.length) {
  console.error("MaintainCode production configuration is incomplete:");
  result.issues.forEach((issue) => console.error(`- ${issue}`));
  process.exit(1);
}
console.log(
  "MaintainCode runtime configuration matches the compiled application.",
);
await import("../server.js");

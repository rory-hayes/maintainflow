import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadNextProductionEnvironment,
  validateStartupProductionConfig,
} from "./check-production-config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = resolve(projectRoot, ".next/standalone");
const serverPath = resolve(standaloneRoot, "server.js");

await loadNextProductionEnvironment();
const result = validateStartupProductionConfig(process.env);
if (result.issues.length > 0) {
  console.error(`Production configuration is not ready for ${result.stage}:`);
  for (const issue of result.issues) console.error(`- ${issue}`);
  process.exit(1);
}

if (!existsSync(serverPath)) {
  console.error(
    "The standalone server is missing. Run npm run build before start:e2e.",
  );
  process.exit(1);
}

const standaloneNextRoot = resolve(standaloneRoot, ".next");
mkdirSync(standaloneNextRoot, { recursive: true });
cpSync(resolve(projectRoot, ".next/static"), resolve(standaloneNextRoot, "static"), {
  recursive: true,
  force: true,
});
const publicRoot = resolve(projectRoot, "public");
if (existsSync(publicRoot)) {
  cpSync(publicRoot, resolve(standaloneRoot, "public"), {
    recursive: true,
    force: true,
  });
}

process.env.HOSTNAME ||= "127.0.0.1";
process.env.PORT ||= "3100";
process.chdir(standaloneRoot);

console.log(
  `Production configuration is valid for ${result.stage}; starting the standalone build on ${process.env.HOSTNAME}:${process.env.PORT}.`,
);
await import(pathToFileURL(serverPath).href);

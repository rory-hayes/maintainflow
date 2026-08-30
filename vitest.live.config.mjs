import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/**/*.acceptance.ts"],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});

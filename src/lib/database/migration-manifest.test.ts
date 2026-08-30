import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { databaseMigrationManifest } from "./migration-manifest";

describe("compiled database migration manifest", () => {
  it("matches every immutable migration in filename order", () => {
    const directory = resolve(process.cwd(), "docs/database");
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const current = files.map((name) => ({
      name,
      checksumSha256: createHash("sha256")
        .update(readFileSync(resolve(directory, name)))
        .digest("hex"),
    }));

    expect(current).toEqual(databaseMigrationManifest);
  });
});

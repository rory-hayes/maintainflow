import manifest from "./migration-manifest.json";

export const databaseMigrationManifest = manifest;

export type DatabaseMigrationManifestEntry =
  (typeof databaseMigrationManifest)[number];

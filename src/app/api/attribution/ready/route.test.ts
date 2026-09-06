import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { query, localMode, revision } = vi.hoisted(() => ({
  query: vi.fn(),
  localMode: vi.fn(),
  revision: vi.fn(),
}));
vi.mock("@/lib/attribution/store.server", () => ({
  database: () => query,
  localMode,
}));
vi.mock("@/lib/release/revision", () => ({ resolveBuildRevision: revision }));
import { GET } from "./route";
const secret = "p".repeat(32);
const sha = "a".repeat(40);
const tableNames = [
  "maintaincode_workspaces",
  "maintaincode_credentials",
  "maintaincode_sites",
  "maintainflow_organizations",
  "maintainflow_organization_memberships",
];
const tables = tableNames.map((relname) => ({
  relname,
  rls_active: relname !== "maintaincode_sites",
  can_read: true,
  can_insert: true,
  can_update: true,
  can_delete: true,
  relrowsecurity: relname !== "maintaincode_sites",
  relforcerowsecurity: relname.startsWith("maintaincode_"),
}));
function success() {
  query
    .mockResolvedValueOnce([
      {
        name: "maintaincode_app",
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      },
    ])
    .mockResolvedValueOnce(tables)
    .mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, n) => ({ policyname: `policy${n}` })),
    );
}
function request(auth = true) {
  return new Request("https://maintainflow.io/api/attribution/ready", {
    headers: auth ? { Authorization: `Bearer ${secret}` } : {},
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAINTAINFLOW_READINESS_PROBE_SECRET", secret);
  localMode.mockReturnValue(false);
  revision.mockReturnValue(sha);
});
afterEach(() => vi.unstubAllEnvs());
describe("attribution deployment readiness", () => {
  it("requires authentication before reading the database", async () => {
    expect((await GET(request(false))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it("reports exact compiled revision and database scope while retaining provider/payment boundaries", async () => {
    success();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ready: true,
      revision: sha,
      scope: "runtime_database_only",
      providers: "not_verified",
      payments: "not_verified",
    });
  });
  it("fails closed before database access when revision provenance is absent", async () => {
    revision.mockReturnValue(null);
    expect((await GET(request())).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects a role that bypasses isolation", async () => {
    query.mockResolvedValueOnce([
      { name: "maintaincode_app", rolbypassrls: true },
    ]);
    expect((await GET(request())).status).toBe(503);
  });
  it("rejects missing membership table grants", async () => {
    query
      .mockResolvedValueOnce([{ name: "maintaincode_app" }])
      .mockResolvedValueOnce(
        tables.map((row) =>
          row.relname === "maintainflow_organization_memberships"
            ? { ...row, can_insert: false }
            : row,
        ),
      );
    expect((await GET(request())).status).toBe(503);
  });
  it("rejects missing isolation policies", async () => {
    query
      .mockResolvedValueOnce([{ name: "maintaincode_app" }])
      .mockResolvedValueOnce(tables)
      .mockResolvedValueOnce([]);
    expect((await GET(request())).status).toBe(503);
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  readWorkspace: vi.fn(),
  siteOwner: vi.fn(),
}));
vi.mock("@/lib/attribution/store.server", () => state);
import { GET } from "./route";
const id = "4f3c61a1-260a-4b4e-a801-b6b3e75d8f81";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://maintainflow.io/");
  state.siteOwner.mockResolvedValue({ organizationId: "workspace" });
  state.readWorkspace.mockResolvedValue({
    sites: [
      {
        id,
        origin: "https://customer.example",
        consent: "required",
        retentionDays: 90,
        adapter: "html",
        formSelector: "form",
        mapping: { submission_id: "mc_submission_id" },
      },
    ],
  });
});
afterEach(() => vi.unstubAllEnvs());
it("emits the configured public loader and collector origin for an internally normalized request", async () => {
  const response = await GET(
    new Request(`http://localhost:3000/t/${id}?test=1`),
    { params: Promise.resolve({ siteId: id }) },
  );
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain('"endpoint":"https://maintainflow.io"');
  expect(body).toContain('"https://maintainflow.io/mc-tracker.js"');
  expect(body).toContain('"test":true');
  expect(body).not.toContain("localhost");
});
it.each(["", "https://maintainflow.io/path", "https://user@maintainflow.io"])(
  "does not emit a tracker with invalid production origin: %s",
  async (origin) => {
    vi.stubEnv("MAINTAINCODE_APP_ORIGIN", origin);
    const response = await GET(new Request(`http://localhost:3000/t/${id}`), {
      params: Promise.resolve({ siteId: id }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("MaintainCodeConfig");
  },
);

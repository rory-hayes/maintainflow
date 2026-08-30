import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("process liveness route", () => {
  it("returns a no-store response without claiming dependency readiness", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "maintainflow-ads",
      scope: "process_liveness",
    });
  });
});

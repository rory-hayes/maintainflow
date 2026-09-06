import { expect, it, vi } from "vitest";
vi.mock("@/lib/attribution/store.server", () => ({ localMode: () => false }));
vi.mock("@/components/attribution/app", () => ({ AttributionApp: () => null }));
import Page from "./page";
it("renders attribution without campaign mutation controls", async () => {
  const page = await Page({ searchParams: Promise.resolve({}) });
  expect(page.props.local).toBe(false);
  expect(page.type.name).toBe("AttributionApp");
});

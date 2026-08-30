import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { WorkspaceOnboarding } from "./workspace-onboarding";

const access = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationName: "Alpine Retail",
  organizationType: "advertiser" as const,
  accountId: "adacct_123",
  accountName: "Alpine Home",
  connectionMode: "vault" as const,
  membershipRole: "owner" as const,
  accountRole: "owner" as const,
};

describe("Workspace measurement connection", () => {
  it("renders only privacy-safe validation evidence for a connected account", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOnboarding
        state="ready"
        access={access}
        connectedAccountName={access.accountName}
        conversionsConnection={{
          state: "connected",
          source: "vault",
          validationEnabled: true,
          credentialVersion: 2,
          validatedAt: "2026-08-30T12:00:00.000Z",
          providerStatus: 202,
          eventCount: 1,
        }}
      />,
    );

    expect(html).toContain("Measurement credential validated");
    expect(html).toContain("Encrypted vault · v2");
    expect(html).toContain("HTTP 202 · 1 event");
    expect(html).toContain("Replace measurement credentials");
    expect(html).not.toContain("pixel_private_123");
    expect(html).not.toContain("capi_private_secret_456");
  });

  it("keeps the preview truthful and prevents credential entry", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOnboarding
        state="demo"
        conversionsConnection={{
          state: "preview",
          source: null,
          validationEnabled: false,
          credentialVersion: null,
          validatedAt: null,
          providerStatus: null,
          eventCount: null,
        }}
      />,
    );

    expect(html).toContain("Measurement connection preview");
    expect(html).toContain("Dry runs paused");
    expect(html).toContain("No provider receipt");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[\s\S]*Connect measurement/,
    );
  });
});

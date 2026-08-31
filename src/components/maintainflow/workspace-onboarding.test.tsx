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

const agencyAccess = {
  ...access,
  organizationName: "Northstar Agency",
  organizationType: "agency" as const,
  accountRole: "manager" as const,
};

const disconnectedMeasurement = {
  state: "not_connected" as const,
  source: null,
  validationEnabled: false,
  credentialVersion: null,
  validatedAt: null,
  providerStatus: null,
  eventCount: null,
};

function findRenderedButton(html: string, label: string) {
  const button = [...html.matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(label));
  expect(button, `Expected a button labelled ${label}`).toBeDefined();
  return button!;
}

describe("Workspace Ads credential recovery", () => {
  it("keeps the connected account visible and lets an authorized owner replace its key", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOnboarding
        state="connection_error"
        access={access}
        connectedAccountName={access.accountName}
        message="The first live sync could not be completed."
        conversionsConnection={disconnectedMeasurement}
      />,
    );

    expect(html).toContain("Live account connection needs attention");
    expect(html).toContain("The first live sync could not be completed.");
    expect(html).toContain(access.accountName);
    expect(html).toContain(access.accountId);
    expect(html).not.toContain("Create workspace");
    expect(findRenderedButton(html, "Replace client key")).not.toMatch(
      /\sdisabled(?:=|>)/,
    );
  });

  it("keeps recovery read-only for an analyst with viewer account access", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOnboarding
        state="connection_error"
        access={{
          ...access,
          membershipRole: "analyst",
          accountRole: "viewer",
        }}
        connectedAccountName={access.accountName}
        message="The live account could not be loaded."
        conversionsConnection={disconnectedMeasurement}
      />,
    );

    expect(findRenderedButton(html, "Replace client key")).toMatch(
      /\sdisabled(?:=|>)/,
    );
    expect(html).toContain(
      "Workspace owners and admins with account-management access can replace this connection.",
    );
  });
});

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

describe("Agency client account connection eligibility", () => {
  it.each(["owner", "admin"] as const)(
    "shows the attach control to a ready live agency %s",
    (membershipRole) => {
      const html = renderToStaticMarkup(
        <WorkspaceOnboarding
          state="ready"
          access={{ ...agencyAccess, membershipRole }}
          connectedAccountName={agencyAccess.accountName}
          conversionsConnection={disconnectedMeasurement}
          agencyClientAttachEnabled
        />,
      );

      expect(html).toContain("Connect client account");
    },
  );

  it.each([
    {
      name: "a direct advertiser",
      state: "ready" as const,
      candidate: access,
      enabled: true,
    },
    {
      name: "an agency analyst",
      state: "ready" as const,
      candidate: { ...agencyAccess, membershipRole: "analyst" as const },
      enabled: true,
    },
    {
      name: "an agency in connection recovery",
      state: "connection_error" as const,
      candidate: agencyAccess,
      enabled: true,
    },
    {
      name: "a simulator workspace",
      state: "demo" as const,
      candidate: undefined,
      enabled: false,
    },
    {
      name: "a signed-out workspace",
      state: "ready" as const,
      candidate: undefined,
      enabled: false,
    },
  ])("does not show the attach control to $name", ({ state, candidate, enabled }) => {
    const html = renderToStaticMarkup(
      <WorkspaceOnboarding
        state={state}
        access={candidate}
        connectedAccountName={candidate?.accountName}
        conversionsConnection={disconnectedMeasurement}
        agencyClientAttachEnabled={enabled}
      />,
    );

    expect(html).not.toContain("Connect client account");
  });
});

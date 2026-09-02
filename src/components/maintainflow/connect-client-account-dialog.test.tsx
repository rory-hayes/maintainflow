import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  ClientAccountConnectionError,
  ConnectClientAccountFields,
  connectClientAdvertiserAccount,
  verifyClientAdvertiserAccount,
} from "./connect-client-account-dialog";

const organizationId = "00000000-0000-4000-8000-000000000002";
type FetchClient = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const access = {
  organizationId,
  organizationName: "Northstar Agency",
  organizationType: "agency" as const,
  accountId: "adacct_client_456",
  accountName: "Harbour Home Ireland",
  connectionMode: "vault" as const,
  membershipRole: "owner" as const,
  accountRole: "manager" as const,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Connect client advertiser account request", () => {
  it("connects only the advertiser identity confirmed in the prior step", async () => {
    const fetchClient = vi.fn<FetchClient>(async () =>
      response({
        created: true,
        credentialUpdated: true,
        access,
        message: "Harbour Home Ireland is connected.",
      }),
    );

    const result = await connectClientAdvertiserAccount({
      organizationId,
      adsApiKey: "  ads_client_secret_123  ",
      expectedAccountId: access.accountId,
      fetchClient,
    });

    expect(fetchClient).toHaveBeenCalledOnce();
    const [url, init] = fetchClient.mock.calls[0];
    expect(url).toBe(
      `/api/organizations/${organizationId}/advertiser-accounts`,
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "connect",
      adsApiKey: "ads_client_secret_123",
      expectedAccountId: access.accountId,
    });
    expect(result).toEqual({
      created: true,
      credentialUpdated: true,
      access,
      message: "Harbour Home Ireland is connected.",
    });
  });

  it("verifies the provider-derived advertiser without requesting attachment", async () => {
    const fetchClient = vi.fn<FetchClient>(async () =>
      response({
        verified: true,
        account: { id: access.accountId, name: access.accountName },
        organization: { id: organizationId, name: "Northstar Agency" },
      }),
    );

    const result = await verifyClientAdvertiserAccount({
      organizationId,
      adsApiKey: " ads_client_secret_123 ",
      fetchClient,
    });

    expect(result.account).toEqual({
      id: access.accountId,
      name: access.accountName,
    });
    expect(JSON.parse(String(fetchClient.mock.calls[0][1]?.body))).toEqual({
      action: "verify",
      adsApiKey: "ads_client_secret_123",
    });
  });

  it("rejects a mismatched organization instead of navigating with untrusted access", async () => {
    const fetchClient = vi.fn<FetchClient>(async () =>
      response({
        created: true,
        credentialUpdated: true,
        access: {
          ...access,
          organizationId: "00000000-0000-4000-8000-000000000099",
        },
      }),
    );

    await expect(
      connectClientAdvertiserAccount({
        organizationId,
        adsApiKey: "ads_client_secret_123",
        expectedAccountId: access.accountId,
        fetchClient,
      }),
    ).rejects.toThrow("could not confirm the attached agency account");
  });

  it("never surfaces an error that reflects the submitted credential", async () => {
    const adsApiKey = "ads_client_secret_123";
    const fetchClient = vi.fn<FetchClient>(async () =>
      response({ error: `Provider rejected ${adsApiKey}` }, 422),
    );

    let caught: unknown;
    try {
      await connectClientAdvertiserAccount({
        organizationId,
        adsApiKey,
        expectedAccountId: access.accountId,
        fetchClient,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientAccountConnectionError);
    expect((caught as Error).message).not.toContain(adsApiKey);
    expect((caught as Error).message).toContain(
      "client account could not be connected",
    );
  });
});

describe("Connect client account fields", () => {
  it("asks only for the advertiser key and explains provider identity discovery", () => {
    const html = renderToStaticMarkup(
      <form>
        <ConnectClientAccountFields
          adsApiKey=""
          attempted={false}
          error={null}
          organizationName="Northstar Agency"
          submitting={false}
          onAdsApiKeyChange={() => undefined}
          onCancel={() => undefined}
        />
      </form>,
    );

    const inputNames = [...html.matchAll(/<input\b[^>]*name="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(inputNames).toEqual(["adsApiKey"]);
    expect(html).toContain("Identity comes from OpenAI");
    expect(html).toContain("discover and verify the advertiser");
    expect(html).toContain("You never enter either value here");
    expect(html).toContain("OpenAI Ads advertiser key");
    expect(html).toContain('type="password"');
    expect(html).toContain("not an OpenAI Platform API key");
    expect(html).toContain("nothing is attached until you confirm");
  });

  it("renders a persistent safe error with an empty credential field", () => {
    const html = renderToStaticMarkup(
      <form>
        <ConnectClientAccountFields
          adsApiKey=""
          attempted={false}
          error="This account is already connected to another workspace."
          organizationName="Northstar Agency"
          submitting={false}
          onAdsApiKeyChange={() => undefined}
          onCancel={() => undefined}
        />
      </form>,
    );

    expect(html).toContain("Client account was not connected");
    expect(html).toContain(
      "This account is already connected to another workspace.",
    );
    expect(html).toContain('value=""');
  });
});

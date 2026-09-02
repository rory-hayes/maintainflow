import { describe, expect, it } from "vitest";

import {
  advertiserAccountAttachSchema,
  canWriteAccount,
  organizationIdSchema,
  selectBestAccountAccess,
  selectBestAccessPerAccount,
  type AccountAccess,
} from "./schema";

function access(
  membershipRole: AccountAccess["membershipRole"],
  accountRole: AccountAccess["accountRole"],
): AccountAccess {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationName: "Northstar",
    organizationType: accountRole === "owner" ? "advertiser" : "agency",
    accountId: "adacct_live",
    accountName: "Harbour Home",
    connectionMode: "vault",
    membershipRole,
    accountRole,
  };
}

describe("customer tenancy roles", () => {
  it("allows advertiser owners and agency managers to write", () => {
    expect(canWriteAccount(access("owner", "owner"))).toBe(true);
    expect(canWriteAccount(access("admin", "manager"))).toBe(true);
  });

  it("keeps analysts and viewers review-only", () => {
    expect(canWriteAccount(access("analyst", "manager"))).toBe(false);
    expect(canWriteAccount(access("owner", "viewer"))).toBe(false);
  });

  it("prefers owner access when a user belongs to more than one workspace", () => {
    expect(
      selectBestAccountAccess([
        access("owner", "manager"),
        access("admin", "owner"),
      ])?.accountRole,
    ).toBe("owner");
  });

  it("prefers an effective writer over a stronger account role blocked by membership", () => {
    expect(
      selectBestAccountAccess([
        access("analyst", "owner"),
        access("admin", "manager"),
      ]),
    ).toMatchObject({
      membershipRole: "admin",
      accountRole: "manager",
    });
  });

  it("returns one strongest access record for every advertiser account", () => {
    const secondAccount = {
      ...access("owner", "manager"),
      accountId: "adacct_second",
      accountName: "Atlas Goods",
    };
    const selected = selectBestAccessPerAccount([
      access("analyst", "viewer"),
      access("owner", "owner"),
      secondAccount,
    ]);

    expect(selected.map((item) => item.accountId)).toEqual([
      "adacct_second",
      "adacct_live",
    ]);
    expect(selected[1].accountRole).toBe("owner");
  });
});

describe("advertiser account attachment input", () => {
  it("accepts a trimmed key for verification and an exact confirmed account", () => {
    expect(
      advertiserAccountAttachSchema.parse({
        action: "verify",
        adsApiKey: "  ads_client_secret_123  ",
      }),
    ).toEqual({ action: "verify", adsApiKey: "ads_client_secret_123" });
    expect(
      advertiserAccountAttachSchema.parse({
        action: "connect",
        adsApiKey: "ads_client_secret_123",
        expectedAccountId: "adacct_verified",
      }),
    ).toEqual({
      action: "connect",
      adsApiKey: "ads_client_secret_123",
      expectedAccountId: "adacct_verified",
    });
  });

  it("rejects attempts to choose the organization or account in the body", () => {
    expect(() =>
      advertiserAccountAttachSchema.parse({
        action: "verify",
        adsApiKey: "ads_client_secret_123",
        organizationId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
    expect(() =>
      advertiserAccountAttachSchema.parse({
        action: "verify",
        adsApiKey: "ads_client_secret_123",
        accountId: "adacct_attacker_selected",
      }),
    ).toThrow();
  });

  it("requires the organization path segment to be a UUID", () => {
    expect(
      organizationIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    ).toBe("00000000-0000-4000-8000-000000000001");
    expect(() => organizationIdSchema.parse("current-agency")).toThrow();
  });
});

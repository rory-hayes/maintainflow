import { z } from "zod";

export const organizationTypeSchema = z.enum(["advertiser", "agency"]);
export const membershipRoleSchema = z.enum(["owner", "admin", "analyst"]);
export const accountAccessRoleSchema = z.enum(["owner", "manager", "viewer"]);
export const accountConnectionModeSchema = z.enum(["environment", "vault"]);

export const accountAccessSchema = z.object({
  organizationId: z.string().uuid(),
  organizationName: z.string(),
  organizationType: organizationTypeSchema,
  accountId: z.string(),
  accountName: z.string(),
  connectionMode: accountConnectionModeSchema,
  membershipRole: membershipRoleSchema,
  accountRole: accountAccessRoleSchema,
});

export const organizationMembershipSchema = z.object({
  organizationId: z.string().uuid(),
  organizationName: z.string(),
  organizationType: organizationTypeSchema,
  membershipRole: membershipRoleSchema,
});

export const workspaceBootstrapSchema = z
  .object({
    organizationName: z.string().trim().min(2).max(120),
    organizationType: organizationTypeSchema,
    adsApiKey: z.string().trim().min(10).max(4096).optional(),
    setupMode: z.enum(["connected", "approval_simulator"]).default("connected"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.setupMode === "approval_simulator" &&
      (value.organizationType !== "agency" || value.adsApiKey)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A credential-free approval workspace must be an agency and cannot include an Ads API key.",
        path: ["setupMode"],
      });
    }
  });

export const organizationIdSchema = z.string().uuid();

const advertiserAccountKeySchema = z.string().trim().min(10).max(4096);

export const advertiserAccountAttachSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("verify"),
      adsApiKey: advertiserAccountKeySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("connect"),
      adsApiKey: advertiserAccountKeySchema,
      expectedAccountId: z.string().trim().min(1).max(255),
    })
    .strict(),
]);

export type OrganizationType = z.infer<typeof organizationTypeSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type AccountAccessRole = z.infer<typeof accountAccessRoleSchema>;
export type AccountConnectionMode = z.infer<
  typeof accountConnectionModeSchema
>;
export type AccountAccess = z.infer<typeof accountAccessSchema>;
export type OrganizationMembership = z.infer<
  typeof organizationMembershipSchema
>;

const membershipRank: Record<MembershipRole, number> = {
  owner: 3,
  admin: 2,
  analyst: 1,
};

const accountRank: Record<AccountAccessRole, number> = {
  owner: 3,
  manager: 2,
  viewer: 1,
};

export function canWriteAccount(access: AccountAccess) {
  return (
    membershipRank[access.membershipRole] >= membershipRank.admin &&
    accountRank[access.accountRole] >= accountRank.manager
  );
}

export function selectBestAccountAccess(accesses: AccountAccess[]) {
  return accesses.toSorted((left, right) => {
    const writeDifference =
      Number(canWriteAccount(right)) - Number(canWriteAccount(left));
    if (writeDifference !== 0) return writeDifference;
    const accountDifference =
      accountRank[right.accountRole] - accountRank[left.accountRole];
    if (accountDifference !== 0) return accountDifference;
    return membershipRank[right.membershipRole] - membershipRank[left.membershipRole];
  })[0] ?? null;
}

export function selectBestAccessPerAccount(accesses: AccountAccess[]) {
  const byAccount = new Map<string, AccountAccess[]>();
  for (const access of accesses) {
    const current = byAccount.get(access.accountId) ?? [];
    current.push(access);
    byAccount.set(access.accountId, current);
  }
  return [...byAccount.values()]
    .map(selectBestAccountAccess)
    .filter((access): access is AccountAccess => access !== null)
    .toSorted((left, right) => left.accountName.localeCompare(right.accountName));
}

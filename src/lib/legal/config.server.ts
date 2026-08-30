import "server-only";

export type PublicLegalIdentity = {
  entityName: string;
  privacyEmail?: string;
  supportEmail?: string;
};

function optionalValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function getPublicLegalIdentity(): PublicLegalIdentity {
  return {
    entityName:
      optionalValue(process.env.MAINTAINFLOW_LEGAL_ENTITY_NAME) ??
      "MaintainFlow private beta",
    privacyEmail: optionalValue(
      process.env.MAINTAINFLOW_PRIVACY_CONTACT_EMAIL,
    ),
    supportEmail: optionalValue(
      process.env.MAINTAINFLOW_SUPPORT_CONTACT_EMAIL,
    ),
  };
}

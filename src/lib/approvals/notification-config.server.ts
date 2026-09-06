import "server-only";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
]);

export class ApprovalNotificationConfigurationError extends Error {
  constructor(message = "Approval email delivery is not configured safely.") {
    super(message);
    this.name = "ApprovalNotificationConfigurationError";
  }
}

export function getApprovalEmailOrganizationIds(
  value = process.env.MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS,
) {
  const ids = (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (ids.some((id) => !UUID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new ApprovalNotificationConfigurationError(
      "The approval email organization allowlist is invalid.",
    );
  }
  return new Set(ids);
}

export function isApprovalEmailEnabledForOrganization(
  organizationId: string,
) {
  if (process.env.MAINTAINFLOW_APPROVAL_EMAIL_ENABLED !== "true") return false;
  if (!UUID_PATTERN.test(organizationId)) return false;
  return getApprovalEmailOrganizationIds().has(organizationId.toLowerCase());
}

function exactHttpsOrigin(value: string | undefined) {
  if (!value) throw new ApprovalNotificationConfigurationError();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || value.replace(/\/$/, "") !== parsed.origin) {
      throw new Error("Invalid origin.");
    }
    return parsed.origin;
  } catch {
    throw new ApprovalNotificationConfigurationError();
  }
}

export function getApprovalNotificationAppOrigin() {
  return exactHttpsOrigin(process.env.MAINTAINFLOW_APP_ORIGIN);
}

export function getApprovalEmailProviderConfiguration() {
  const apiKey = process.env.RESEND_API_KEY;
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const fromEmail = process.env.MAINTAINFLOW_APPROVAL_FROM_EMAIL;
  const fromDomain = fromEmail
    ? fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase()
    : "";
  if (
    !apiKey?.startsWith("re_") ||
    apiKey.length < 20 ||
    !webhookSecret?.startsWith("whsec_") ||
    webhookSecret.length < 20 ||
    !fromEmail ||
    fromEmail.length > 254 ||
    !EMAIL_PATTERN.test(fromEmail) ||
    fromEmail.slice(0, fromEmail.indexOf("@")).includes("..") ||
    [...RESERVED_EMAIL_DOMAINS].some(
      (reserved) =>
        fromDomain === reserved || fromDomain.endsWith(`.${reserved}`),
    ) ||
    [".test", ".invalid", ".example", ".localhost", ".local"].some(
      (suffix) => fromDomain.endsWith(suffix),
    )
  ) {
    throw new ApprovalNotificationConfigurationError();
  }
  return {
    apiKey,
    webhookSecret,
    from: `MaintainFlow <${fromEmail}>`,
    appOrigin: getApprovalNotificationAppOrigin(),
  };
}

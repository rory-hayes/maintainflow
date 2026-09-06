export function isClerkConfigured() {
  return Boolean(
    process.env.CLERK_SECRET_KEY &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

const OPERATOR_ID_PATTERN = /^user_[A-Za-z0-9_-]{1,250}$/;

function parseOperatorIds(value: string | undefined): string[] | null {
  if (value === undefined || value.trim().length === 0) return [];

  const operatorIds = value.split(",").map((operatorId) => operatorId.trim());
  if (
    operatorIds.some(
      (operatorId) =>
        operatorId.length === 0 || !OPERATOR_ID_PATTERN.test(operatorId),
    ) ||
    new Set(operatorIds).size !== operatorIds.length
  ) {
    return null;
  }

  return operatorIds;
}

export function getBootstrapOperatorIds() {
  return new Set(
    parseOperatorIds(process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS) ?? [],
  );
}

export function isBootstrapOperator(operatorId: string) {
  return getBootstrapOperatorIds().has(operatorId);
}

export function getWorkspaceAdmittedOperatorIds(): string[] {
  const privateBetaOperatorIds = parseOperatorIds(
    process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS,
  );
  const bootstrapOperatorIds = parseOperatorIds(
    process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS,
  );
  if (privateBetaOperatorIds === null || bootstrapOperatorIds === null) {
    return [];
  }

  const combinedOperatorIds = [
    ...privateBetaOperatorIds,
    ...bootstrapOperatorIds,
  ];
  if (new Set(combinedOperatorIds).size !== combinedOperatorIds.length) {
    return [];
  }

  return [...combinedOperatorIds].sort();
}

export function getWorkspaceAdmissionMode() {
  return process.env.MAINTAINFLOW_ADMISSION_MODE === "open"
    ? "open"
    : "private_beta";
}

export function isPublicSignUpEnabled() {
  return (
    getWorkspaceAdmissionMode() === "open" &&
    process.env.MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED === "true"
  );
}

export function isWorkspaceAdmissionAllowed(operatorId: string) {
  return (
    getWorkspaceAdmissionMode() === "open" ||
    getWorkspaceAdmittedOperatorIds().includes(operatorId)
  );
}

export function isClerkConfigured() {
  return Boolean(
    process.env.CLERK_SECRET_KEY &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

export function getBootstrapOperatorIds() {
  return new Set(
    (process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isBootstrapOperator(operatorId: string) {
  return getBootstrapOperatorIds().has(operatorId);
}

function privateBetaOperatorIds() {
  return new Set(
    (process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
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
    privateBetaOperatorIds().has(operatorId) ||
    isBootstrapOperator(operatorId)
  );
}

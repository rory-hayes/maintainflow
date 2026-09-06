const APPROVAL_DELIVERY_RETURN_TO =
  /^\/approvals\/open\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function safeSignInReturnTo(value: string | string[] | undefined) {
  return typeof value === "string" && APPROVAL_DELIVERY_RETURN_TO.test(value)
    ? value
    : "/app";
}

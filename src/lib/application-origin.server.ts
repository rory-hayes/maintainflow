import "server-only";

export function applicationOrigin(request: Request) {
  const configured = process.env.MAINTAINCODE_APP_ORIGIN;
  if (!configured) {
    if (process.env.NODE_ENV === "production")
      throw new Error("Configure the application origin.");
    return new URL(request.url).origin;
  }
  try {
    const origin = new URL(configured);
    const localHttp =
      process.env.NODE_ENV !== "production" &&
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (
      (origin.protocol !== "https:" && !localHttp) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Invalid application origin.");
    return origin.origin;
  } catch {
    throw new Error("Configure a valid application origin.");
  }
}

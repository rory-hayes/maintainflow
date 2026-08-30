import "server-only";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("The request body is too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

export function isSecureSameOriginRequest(request: Request) {
  if (process.env.NODE_ENV !== "production") return true;
  const configuredOrigin = process.env.MAINTAINFLOW_APP_ORIGIN;
  if (!configuredOrigin) return false;

  let canonicalOrigin: URL;
  try {
    canonicalOrigin = new URL(configuredOrigin);
  } catch {
    return false;
  }
  if (
    canonicalOrigin.protocol !== "https:" ||
    configuredOrigin.replace(/\/$/, "") !== canonicalOrigin.origin
  ) {
    return false;
  }

  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const secure =
    requestUrl.protocol === "https:" ||
    (process.env.MAINTAINFLOW_TRUST_PROXY_HEADERS === "true" &&
      forwardedProtocol === "https");
  const origin = request.headers.get("origin");
  if (!secure || origin !== canonicalOrigin.origin) return false;
  try {
    const requestHost = request.headers.get("host") ?? requestUrl.host;
    return requestHost === canonicalOrigin.host;
  } catch {
    return false;
  }
}

export function requestBodyExceeds(
  request: Request,
  maximumBytes: number,
) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(contentLength) && contentLength > maximumBytes;
}

export async function readBodyWithLimit(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  if (requestBodyExceeds(request, maximumBytes)) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    body += decoder.decode(value, { stream: true });
  }

  return body + decoder.decode();
}

export async function readJsonBodyWithLimit(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  return JSON.parse(await readBodyWithLimit(request, maximumBytes));
}

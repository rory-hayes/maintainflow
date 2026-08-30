const ADS_RESOURCE_TYPES = ["campaigns", "ad_groups", "ads"] as const;
const ADS_RESOURCE_ACTIONS = ["activate", "pause"] as const;
const ADS_RESOURCE_ID_MAX_LENGTH = 512;
const ADS_PATH_ORIGIN = "https://ads-path.invalid";

export type AdsResourceType = (typeof ADS_RESOURCE_TYPES)[number];
export type AdsResourceAction = (typeof ADS_RESOURCE_ACTIONS)[number];

export type ParsedAdsResourcePath = {
  resource: AdsResourceType;
  entityId: string;
  encodedEntityId: string;
  action?: AdsResourceAction;
};

function isResourceType(value: string): value is AdsResourceType {
  return ADS_RESOURCE_TYPES.includes(value as AdsResourceType);
}

function isResourceAction(value: string): value is AdsResourceAction {
  return ADS_RESOURCE_ACTIONS.includes(value as AdsResourceAction);
}

function encodeResourceId(entityId: string) {
  if (
    entityId.length === 0 ||
    entityId.length > ADS_RESOURCE_ID_MAX_LENGTH ||
    entityId === "." ||
    entityId === ".."
  ) {
    throw new Error("The Ads resource ID is outside the supported length limit.");
  }
  return encodeURIComponent(entityId);
}

export function buildAdsResourcePath(
  resource: AdsResourceType,
  entityId: string,
  action?: AdsResourceAction,
) {
  const path = `/${resource}/${encodeResourceId(entityId)}`;
  return action ? `${path}/${action}` : path;
}

export function parseAdsResourcePath(path: string): ParsedAdsResourcePath {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Ads resource paths must be relative to the configured origin.");
  }

  const parsed = new URL(path, ADS_PATH_ORIGIN);
  if (
    parsed.origin !== ADS_PATH_ORIGIN ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.pathname !== path
  ) {
    throw new Error("The Ads resource path is not canonical.");
  }

  const segments = path.slice(1).split("/");
  if (segments.length !== 2 && segments.length !== 3) {
    throw new Error("The Ads resource path shape is not supported.");
  }

  const [resource, encodedEntityId, action] = segments;
  if (!isResourceType(resource) || !encodedEntityId) {
    throw new Error("The Ads resource path shape is not supported.");
  }
  if (action !== undefined && !isResourceAction(action)) {
    throw new Error("The Ads resource action is not supported.");
  }

  let entityId: string;
  try {
    entityId = decodeURIComponent(encodedEntityId);
  } catch {
    throw new Error("The Ads resource ID is not valid percent encoding.");
  }
  if (encodeResourceId(entityId) !== encodedEntityId) {
    throw new Error("The Ads resource ID is not canonically encoded.");
  }

  return {
    resource,
    entityId,
    encodedEntityId,
    ...(action ? { action } : {}),
  };
}

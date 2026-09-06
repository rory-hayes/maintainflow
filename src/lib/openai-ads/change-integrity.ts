import { createHash } from "node:crypto";

import { z } from "zod";

import type { ScopedAdGroup } from "./recommendations";
import type { AdAccount, Campaign, ScopedAd } from "./schema";
import {
  CHANGE_INTEGRITY_PROJECTION_VERSION,
  changeIntegrityCandidateSchema,
  changeIntegrityOperationEvidenceSchema,
  changeIntegrityResourceSchema,
  changeIntegritySnapshotSchema,
  type ChangeIntegrityCandidate,
  type ChangeIntegrityClassification,
  type ChangeIntegrityOperationEvidence,
  type ChangeIntegrityResource,
  type ChangeIntegrityResourceType,
  type ChangeIntegritySnapshot,
} from "./change-integrity-schema";

export * from "./change-integrity-schema";

type IntegritySnapshotInput = {
  account: AdAccount;
  campaigns: Campaign[];
  adGroups: ScopedAdGroup[];
  ads: ScopedAd[];
  observationStartedAt?: string;
  observedAt: string;
};

const UNORDERED_ARRAY_KEYS = new Set([
  "context_hints",
  "conversion_event_setting_ids",
  "countries",
  "custom_audience_bid_multipliers",
  "filters",
  "ids",
  "include",
  "included",
  "negative_keywords",
  "values",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, withoutUndefined(item)]],
    ),
  );
}

function canonicalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return UNORDERED_ARRAY_KEYS.has(key ?? "")
      ? items.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        )
      : items;
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, item]) => [
        entryKey,
        canonicalize(item, entryKey),
      ]),
  );
}

export function changeIntegrityFingerprint(value: unknown) {
  const serialized = JSON.stringify(
    canonicalize(withoutUndefined(value)),
  );
  return createHash("sha256")
    .update(serialized ?? "<maintainflow:undefined>")
    .digest("hex");
}

function knownObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    keys.flatMap((key) =>
      value[key] === undefined ? [] : [[key, value[key]]],
    ),
  );
}

function projectGeoLocations(value: unknown) {
  if (!isRecord(value)) return null;
  const include = Array.isArray(value.include)
    ? value.include.map((location) =>
        knownObject(location, [
          "id",
          "name",
          "type",
          "country_code",
          "region_code",
        ]),
      )
    : undefined;
  return withoutUndefined({
    countries: value.countries,
    include,
  });
}

function projectTargeting(value: unknown) {
  if (!isRecord(value)) return null;
  return withoutUndefined({
    locations: projectGeoLocations(value.locations),
    excluded_locations: projectGeoLocations(value.excluded_locations),
    custom_audiences: knownObject(value.custom_audiences, ["ids"]),
    excluded_custom_audiences: knownObject(value.excluded_custom_audiences, [
      "ids",
    ]),
    platforms: knownObject(value.platforms, ["included"]),
  });
}

function projectLandingPageConfiguration(value: unknown) {
  return knownObject(value, ["query_string_template"]);
}

function projectBudget(value: unknown) {
  return (
    knownObject(value, [
      "lifetime_spend_limit_micros",
      "daily_spend_limit_micros",
    ]) ?? {}
  );
}

function projectBiddingConfig(value: unknown) {
  if (!isRecord(value)) return null;
  const multipliers = Array.isArray(value.custom_audience_bid_multipliers)
    ? value.custom_audience_bid_multipliers.map((multiplier) =>
        knownObject(multiplier, [
          "custom_audience_id",
          "bid_multiplier_micros",
        ]),
      )
    : undefined;
  return withoutUndefined({
    billing_event_type: value.billing_event_type,
    strategy: value.strategy,
    max_bid_micros: value.max_bid_micros,
    custom_audience_bid_multipliers: multipliers,
  });
}

function projectProductSet(value: unknown) {
  if (!isRecord(value)) return null;
  const filters = Array.isArray(value.filters)
    ? value.filters.map((filter) =>
        knownObject(filter, ["field", "operator", "values"]),
      )
    : undefined;
  return withoutUndefined({
    product_feed_id: value.product_feed_id,
    filters,
  });
}

function projectCreative(value: unknown) {
  return knownObject(value, [
    "type",
    "title",
    "body",
    "price",
    "target_url",
    "file_id",
    "image_crop",
  ]);
}

function resource(options: Omit<ChangeIntegrityResource, "fingerprint">) {
  const configuration = canonicalize(
    withoutUndefined(options.configuration),
  ) as Record<string, unknown>;
  return changeIntegrityResourceSchema.parse({
    ...options,
    configuration,
    fingerprint: changeIntegrityFingerprint(configuration),
  });
}

const resourceOrder: Record<ChangeIntegrityResourceType, number> = {
  ad_account: 0,
  campaign: 1,
  ad_group: 2,
  ad: 3,
};

export function buildChangeIntegritySnapshot(
  input: IntegritySnapshotInput,
): ChangeIntegritySnapshot {
  const resources: ChangeIntegrityResource[] = [
    resource({
      resourceType: "ad_account",
      resourceId: input.account.id,
      parentResourceId: null,
      resourceLabel: input.account.name,
      providerUpdatedAt: null,
      configuration: {
        name: input.account.name,
        status: input.account.status ?? null,
        url: input.account.url,
        timezone: input.account.timezone,
        currency_code: input.account.currency_code,
        negative_keywords: input.account.negative_keywords ?? [],
      },
    }),
    ...input.campaigns.map((campaign) =>
      resource({
        resourceType: "campaign",
        resourceId: campaign.id,
        parentResourceId: input.account.id,
        resourceLabel: campaign.name,
        providerUpdatedAt: campaign.updated_at,
        configuration: {
          name: campaign.name,
          description: campaign.description,
          status: campaign.status,
          start_time: campaign.start_time,
          end_time: campaign.end_time,
          budget: projectBudget(campaign.budget),
          bidding_type: campaign.bidding_type,
          objective: campaign.objective,
          billing_event_type: campaign.billing_event_type,
          mode: campaign.mode ?? null,
          product_feed_id: campaign.product_feed_id,
          business_agent_id: campaign.business_agent_id ?? null,
          targeting: projectTargeting(campaign.targeting),
          landing_page_configuration: projectLandingPageConfiguration(
            campaign.landing_page_configuration,
          ),
          conversion_event_setting_ids:
            campaign.conversion_event_setting_ids ?? [],
        },
      }),
    ),
    ...input.adGroups.map((adGroup) =>
      resource({
        resourceType: "ad_group",
        resourceId: adGroup.id,
        parentResourceId: adGroup.campaign_id,
        resourceLabel: adGroup.name,
        providerUpdatedAt: adGroup.updated_at,
        configuration: {
          campaign_id: adGroup.campaign_id,
          name: adGroup.name,
          description: adGroup.description,
          context_hints: adGroup.context_hints,
          status: adGroup.status,
          bidding_config: projectBiddingConfig(adGroup.bidding_config),
          product_set: projectProductSet(adGroup.product_set),
          landing_page_configuration: projectLandingPageConfiguration(
            adGroup.landing_page_configuration,
          ),
        },
      }),
    ),
    ...input.ads.map((ad) =>
      resource({
        resourceType: "ad",
        resourceId: ad.id,
        parentResourceId: ad.ad_group_id,
        resourceLabel: ad.name,
        providerUpdatedAt: ad.updated_at,
        configuration: {
          ad_group_id: ad.ad_group_id,
          name: ad.name,
          status: ad.status,
          creative: projectCreative(ad.creative),
          landing_page_configuration: projectLandingPageConfiguration(
            ad.landing_page_configuration,
          ),
        },
      }),
    ),
  ].sort(
    (left, right) =>
      resourceOrder[left.resourceType] - resourceOrder[right.resourceType] ||
      left.resourceId.localeCompare(right.resourceId),
  );

  return changeIntegritySnapshotSchema.parse({
    projectionVersion: CHANGE_INTEGRITY_PROJECTION_VERSION,
    accountId: input.account.id,
    observationStartedAt: input.observationStartedAt ?? input.observedAt,
    observedAt: input.observedAt,
    resources,
  });
}

function resourceKey(resource: {
  resourceType: ChangeIntegrityResourceType;
  resourceId: string;
}) {
  return `${resource.resourceType}:${resource.resourceId}`;
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value) || !isRecord(value)) return prefix ? [prefix] : [];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, item]) =>
    leafPaths(item, prefix ? `${prefix}.${key}` : key),
  );
}

function changedPaths(
  previous: unknown,
  current: unknown,
  prefix = "",
): string[] {
  if (changeIntegrityFingerprint(previous) === changeIntegrityFingerprint(current)) {
    return [];
  }
  if (Array.isArray(previous) || Array.isArray(current)) {
    return prefix ? [prefix] : ["resource"];
  }
  if (!isRecord(previous) || !isRecord(current)) {
    return prefix ? [prefix] : ["resource"];
  }
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .sort();
  return keys.flatMap((key) =>
    changedPaths(
      previous[key],
      current[key],
      prefix ? `${prefix}.${key}` : key,
    ),
  );
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    return isRecord(current) ? current[segment] : undefined;
  }, value);
}

function operationExplainsPath(
  operation: ChangeIntegrityOperationEvidence,
  currentConfiguration: Record<string, unknown> | null,
  path: string,
) {
  if (!currentConfiguration) return false;
  const expectedPaths = leafPaths(operation.expectedState);
  if (!expectedPaths.includes(path)) return false;
  const key = path.split(".").at(-1);
  return (
    JSON.stringify(
      canonicalize(
        withoutUndefined(valueAtPath(operation.expectedState, path)),
        key,
      ),
    ) ===
    JSON.stringify(
      canonicalize(
        withoutUndefined(valueAtPath(currentConfiguration, path)),
        key,
      ),
    )
  );
}

function latestOperationsTargetingPath(
  operations: ChangeIntegrityOperationEvidence[],
  path: string,
) {
  const targeted = operations.filter((operation) =>
    leafPaths(operation.expectedState).includes(path),
  );
  const latestOccurredAt = targeted.at(-1)?.occurredAt;
  return latestOccurredAt
    ? targeted.filter((operation) => operation.occurredAt === latestOccurredAt)
    : [];
}

function candidateFingerprint(value: Omit<ChangeIntegrityCandidate, "eventFingerprint">) {
  return changeIntegrityFingerprint({
    accountId: value.accountId,
    resourceType: value.resourceType,
    resourceId: value.resourceId,
    changeType: value.changeType,
    classification: value.classification,
    previousFingerprint: value.previousFingerprint,
    currentFingerprint: value.currentFingerprint,
    changedFieldPaths: value.changedFieldPaths,
    explainedFieldPaths: value.explainedFieldPaths,
    indeterminateFieldPaths: value.indeterminateFieldPaths,
    unexplainedFieldPaths: value.unexplainedFieldPaths,
    matchedApprovalIds: value.matchedOperations.map((item) => item.approvalId),
    baselineObservationStartedAt: value.baselineObservationStartedAt,
    baselineObservedAt: value.baselineObservedAt,
    detectionStartedAt: value.detectionStartedAt,
    detectedAt: value.detectedAt,
  });
}

export function compareChangeIntegritySnapshots(options: {
  previous: ChangeIntegritySnapshot;
  current: ChangeIntegritySnapshot;
  operations?: ChangeIntegrityOperationEvidence[];
}): ChangeIntegrityCandidate[] {
  const previous = changeIntegritySnapshotSchema.parse(options.previous);
  const current = changeIntegritySnapshotSchema.parse(options.current);
  if (previous.accountId !== current.accountId) {
    throw new TypeError("Integrity snapshots must belong to the same advertiser account.");
  }
  if (Date.parse(current.observedAt) < Date.parse(previous.observedAt)) {
    throw new TypeError("A change-integrity snapshot cannot move backwards in time.");
  }
  if (
    Date.parse(current.observationStartedAt) < Date.parse(previous.observedAt)
  ) {
    throw new TypeError(
      "Change-integrity observation intervals cannot overlap.",
    );
  }

  const operations = z
    .array(changeIntegrityOperationEvidenceSchema)
    .max(1_000)
    .parse(options.operations ?? [])
    .filter(
      (operation) =>
        Date.parse(operation.occurredAt) >=
          Date.parse(previous.observationStartedAt) &&
        Date.parse(operation.occurredAt) <= Date.parse(current.observedAt),
    )
    .map((operation) =>
      operation.certainty === "confirmed" &&
      Date.parse(operation.occurredAt) >=
        Date.parse(current.observationStartedAt)
        ? changeIntegrityOperationEvidenceSchema.parse({
            ...operation,
            certainty: "indeterminate",
            uncertaintyReason: "snapshot_timing",
          })
        : operation,
    );
  const previousByKey = new Map(
    previous.resources.map((item) => [resourceKey(item), item]),
  );
  const currentByKey = new Map(
    current.resources.map((item) => [resourceKey(item), item]),
  );
  const keys = [...new Set([...previousByKey.keys(), ...currentByKey.keys()])]
    .sort();

  return keys.flatMap((key): ChangeIntegrityCandidate[] => {
    const previousResource = previousByKey.get(key) ?? null;
    const currentResource = currentByKey.get(key) ?? null;
    if (previousResource?.fingerprint === currentResource?.fingerprint) return [];
    const representative = currentResource ?? previousResource!;
    const changeType = !previousResource
      ? "created"
      : !currentResource
        ? "removed"
        : "updated";
    const allChangedPaths = (
      changeType === "created"
        ? leafPaths(currentResource!.configuration)
        : changeType === "removed"
          ? leafPaths(previousResource!.configuration)
          : changedPaths(
              previousResource!.configuration,
              currentResource!.configuration,
            )
    ).sort();
    const relevantOperations = operations
      .filter(
        (operation) =>
          operation.resourceType === representative.resourceType &&
          operation.resourceId === representative.resourceId,
      )
      .sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          left.approvalId.localeCompare(right.approvalId),
      );
    const confirmedPaths = new Set<string>();
    const indeterminatePaths = new Set<string>();
    const matchedOperationKeys = new Set<string>();
    for (const path of allChangedPaths) {
      const latestTargeting = latestOperationsTargetingPath(
        relevantOperations,
        path,
      );
      const matchingLatest = latestTargeting.filter((operation) =>
        operationExplainsPath(
          operation,
          currentResource?.configuration ?? null,
          path,
        ),
      );
      if (matchingLatest.length === 0) continue;
      if (matchingLatest.length !== latestTargeting.length) {
        for (const operation of latestTargeting) {
          matchedOperationKeys.add(
            `${operation.approvalId}:${operation.mode}:${operation.occurredAt}`,
          );
        }
        continue;
      }
      for (const operation of matchingLatest) {
        matchedOperationKeys.add(
          `${operation.approvalId}:${operation.mode}:${operation.occurredAt}`,
        );
      }
      if (
        matchingLatest.every((operation) => operation.certainty === "confirmed")
      ) {
        confirmedPaths.add(path);
      } else {
        indeterminatePaths.add(path);
      }
    }
    const explainedFieldPaths = allChangedPaths.filter((path) =>
      confirmedPaths.has(path),
    );
    const unresolvedAfterConfirmed = allChangedPaths.filter(
      (path) => !confirmedPaths.has(path),
    );
    const indeterminateFieldPaths = unresolvedAfterConfirmed.filter((path) =>
      indeterminatePaths.has(path),
    );
    const unexplainedFieldPaths = unresolvedAfterConfirmed.filter(
      (path) => !indeterminatePaths.has(path),
    );
    const classification: ChangeIntegrityClassification =
      unexplainedFieldPaths.length > 0
        ? "unexplained"
        : indeterminateFieldPaths.length > 0
          ? "indeterminate"
          : "maintainflow_consistent";
    const matchedOperations = relevantOperations.filter((operation) =>
      matchedOperationKeys.has(
        `${operation.approvalId}:${operation.mode}:${operation.occurredAt}`,
      ),
    );
    const candidateWithoutFingerprint = {
      accountId: current.accountId,
      resourceType: representative.resourceType,
      resourceId: representative.resourceId,
      parentResourceId: representative.parentResourceId,
      resourceLabel: representative.resourceLabel,
      providerUpdatedAt:
        currentResource?.providerUpdatedAt ??
        previousResource?.providerUpdatedAt ??
        null,
      changeType,
      classification,
      previousFingerprint: previousResource?.fingerprint ?? null,
      currentFingerprint: currentResource?.fingerprint ?? null,
      previousConfiguration: previousResource?.configuration ?? null,
      currentConfiguration: currentResource?.configuration ?? null,
      changedFieldPaths: allChangedPaths,
      explainedFieldPaths,
      indeterminateFieldPaths,
      unexplainedFieldPaths,
      matchedOperations,
      baselineObservationStartedAt: previous.observationStartedAt,
      baselineObservedAt: previous.observedAt,
      detectionStartedAt: current.observationStartedAt,
      detectedAt: current.observedAt,
    } satisfies Omit<ChangeIntegrityCandidate, "eventFingerprint">;
    return [
      changeIntegrityCandidateSchema.parse({
        ...candidateWithoutFingerprint,
        eventFingerprint: candidateFingerprint(candidateWithoutFingerprint),
      }),
    ];
  });
}

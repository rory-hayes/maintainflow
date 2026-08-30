export const releaseStages = ["demo", "private_read", "live_write"] as const;

export type ReleaseStage = (typeof releaseStages)[number];
export type ResolvedReleaseStage = ReleaseStage | "invalid";

export function resolveReleaseStage(
  value: string | undefined = process.env.MAINTAINFLOW_RELEASE_STAGE,
): ResolvedReleaseStage {
  const configured = value ?? "demo";
  return releaseStages.includes(configured as ReleaseStage)
    ? (configured as ReleaseStage)
    : "invalid";
}

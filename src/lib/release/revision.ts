const GIT_REVISION_PATTERN = /^[a-f0-9]{7,64}$/i;

export function resolveBuildRevision(
  compiledRevision: string | undefined =
    process.env.MAINTAINFLOW_COMPILED_BUILD_SHA,
) {
  const normalized = compiledRevision?.trim();
  return normalized && GIT_REVISION_PATTERN.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

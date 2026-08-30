export const appTabs = [
  "review",
  "campaigns",
  "experiments",
  "readiness",
  "workspace",
] as const;

export type AppTab = (typeof appTabs)[number];

export function parseAppTab(value: string | string[] | undefined): AppTab | null {
  if (typeof value !== "string") return null;
  return appTabs.includes(value as AppTab) ? (value as AppTab) : null;
}

export function buildAppHref(options: {
  tab: AppTab;
  accountId?: string;
}) {
  const searchParams = new URLSearchParams({ tab: options.tab });
  if (options.accountId) searchParams.set("account", options.accountId);
  return `/app?${searchParams.toString()}`;
}

export function replaceAppTabInUrl(
  location: { pathname: string; search: string; hash: string },
  tab: AppTab,
) {
  const searchParams = new URLSearchParams(location.search);
  searchParams.set("tab", tab);
  const search = searchParams.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}

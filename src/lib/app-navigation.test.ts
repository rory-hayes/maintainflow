import { describe, expect, it } from "vitest";

import {
  buildAppHref,
  parseAppTab,
  replaceAppTabInUrl,
} from "./app-navigation";

describe("MaintainFlow app navigation", () => {
  it("accepts only named product tabs", () => {
    expect(parseAppTab("readiness")).toBe("readiness");
    expect(parseAppTab("workspace")).toBe("workspace");
    expect(parseAppTab("billing")).toBeNull();
    expect(parseAppTab(["review", "workspace"])).toBeNull();
    expect(parseAppTab(undefined)).toBeNull();
  });

  it("builds an exact deep link and safely encodes account context", () => {
    expect(buildAppHref({ tab: "campaigns" })).toBe("/app?tab=campaigns");
    expect(
      buildAppHref({ tab: "readiness", accountId: "adacct/client one" }),
    ).toBe("/app?tab=readiness&account=adacct%2Fclient+one");
  });

  it("switches tabs without dropping account context or other safe URL state", () => {
    expect(
      replaceAppTabInUrl(
        {
          pathname: "/app",
          search: "?tab=review&account=adacct_client&source=pilot",
          hash: "#evidence",
        },
        "campaigns",
      ),
    ).toBe(
      "/app?tab=campaigns&account=adacct_client&source=pilot#evidence",
    );
  });
});

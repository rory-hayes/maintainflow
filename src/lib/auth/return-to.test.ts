import { describe, expect, it } from "vitest";

import { safeSignInReturnTo } from "./return-to";

describe("sign-in return path", () => {
  it("accepts only exact internal approval delivery paths", () => {
    const path =
      "/approvals/open/00000000-0000-4000-8000-000000000101";
    expect(safeSignInReturnTo(path)).toBe(path);
    expect(safeSignInReturnTo("https://attacker.example/path")).toBe("/app");
    expect(safeSignInReturnTo("//attacker.example/path")).toBe("/app");
    expect(safeSignInReturnTo(`${path}?next=https://attacker.example`)).toBe(
      "/app",
    );
    expect(safeSignInReturnTo([path])).toBe("/app");
  });
});

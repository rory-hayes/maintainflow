import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LeadDetail, Leads } from "./reporting";
import { sampleWorkspace } from "@/lib/attribution/sample";

it("does not describe a contact identity match as verified attribution fields", () => {
  const w = sampleWorkspace();
  w.submissions = [{ ...w.submissions[0], crmFieldsVerifiedAt: undefined }];
  const markup = renderToStaticMarkup(
    <LeadDetail w={w} lead={w.submissions[0]} onBack={() => {}} />,
  );
  expect(markup).toContain("Last contact identity match");
  expect(markup).toContain(
    "a contact match alone does not prove field delivery",
  );
  const list = renderToStaticMarkup(<Leads w={w} onLead={() => {}} />);
  expect(list).toContain("Contact matched");
  expect(list).not.toContain(
    '<span class="mc-status good">CRM fields verified',
  );
});

it("shows actionable missing-field diagnostics without exposing source values", () => {
  const w = sampleWorkspace();
  const lead = {
    ...w.submissions[0],
    crmFieldsVerifiedAt: undefined,
    crmFieldDiagnostics: {
      status: "missing" as const,
      missing: ["first_source"],
      mismatched: ["latest_campaign"],
    },
  };
  const markup = renderToStaticMarkup(
    <LeadDetail w={w} lead={lead} onBack={() => {}} />,
  );
  expect(markup).toContain("Missing mapped fields: first_source");
  expect(markup).toContain("Different mapped values: latest_campaign");
  expect(markup).toContain("Customer corrections are not overwritten.");
});

it("bounds the initial lead table and provides access to remaining records", () => {
  const w = sampleWorkspace();
  const markup = renderToStaticMarkup(<Leads w={w} onLead={() => {}} />);
  expect((markup.match(/<tr/g) ?? []).length).toBe(51);
  expect(markup).toContain("Page 1 of 3");
  expect(markup).toContain("128 records");
});

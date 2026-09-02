import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Progress } from "./progress";
import { Table, TableBody, TableCell, TableRow } from "./table";

describe("accessible data primitives", () => {
  it("keeps progress values attached to a contextual accessible name", () => {
    const html = renderToStaticMarkup(
      <Progress value={66} aria-label="Upload progress" />,
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Upload progress"');
    expect(html).toContain('aria-valuenow="66"');
    expect(html).toContain("motion-reduce:transition-none");
  });

  it("names and keyboard-enables the table scroll area", () => {
    const html = renderToStaticMarkup(
      <Table scrollAreaLabel="Recent invoices">
        <TableBody>
          <TableRow>
            <TableCell>INV-001</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Recent invoices"');
    expect(html).toContain('tabindex="0"');
  });
});

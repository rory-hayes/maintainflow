export const PRODUCT_FEED_MAX_BYTES = 5_000_000;
export const PRODUCT_FEED_MAX_ROWS = 50_000;

const GOOGLE_CORE_COLUMNS = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "availability",
  "price",
  "brand",
] as const;

const SUPPORTED_AVAILABILITY = new Set([
  "in_stock",
  "out_of_stock",
  "backorder",
  "preorder",
]);

export type ProductFeedIssueSeverity = "error" | "warning";

export type ProductFeedIssue = {
  code: string;
  severity: ProductFeedIssueSeverity;
  title: string;
  detail: string;
  count: number;
  sampleRows: number[];
};

export type ProductFeedAudit = {
  fileName: string;
  format: "csv" | "tsv" | "txt";
  rowCount: number;
  adsEligibleRows: number;
  blockedRows: number;
  warningRows: number;
  verdict: "ready" | "needs_work" | "invalid";
  issues: ProductFeedIssue[];
};

type AuditOptions = {
  byteLength?: number;
  now?: Date;
};

type MutableIssue = Omit<ProductFeedIssue, "count" | "sampleRows"> & {
  rows: Set<number>;
};

function feedFormat(fileName: string): ProductFeedAudit["format"] {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith(".csv")) return "csv";
  if (normalized.endsWith(".tsv")) return "tsv";
  if (normalized.endsWith(".txt")) return "txt";
  throw new Error(
    "Choose a UTF-8 .csv, .tsv, or .txt product feed. Expand compressed feeds before auditing them.",
  );
}

function firstRecord(text: string) {
  let quoted = false;
  let record = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        record += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && (character === "\n" || character === "\r")) break;
    record += character;
  }

  return record;
}

function delimiterFor(format: ProductFeedAudit["format"], text: string) {
  if (format === "csv") return ",";
  if (format === "tsv") return "\t";
  const header = firstRecord(text);
  return header.split("\t").length > header.split(",").length ? "\t" : ",";
}

export function parseDelimitedProductFeed(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(value);
      value = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (quoted) {
    throw new Error("The product feed contains an unclosed quoted value.");
  }

  row.push(value);
  if (row.some((cell) => cell.trim().length > 0)) rows.push(row);
  return rows;
}

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function isPublicHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function parsePrice(value: string) {
  const match = /^(\d+(?:\.\d{1,6})?)\s+([A-Z]{3})$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: match[2] };
}

function isFutureDate(value: string, now: Date) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function hasProductIdentifier(row: Record<string, string>) {
  const identifierExists = row.identifier_exists?.trim().toLowerCase();
  if (identifierExists === "no") return true;
  if (identifierExists && identifierExists !== "yes") return false;

  const gtin = row.gtin
    ?.split(",")[0]
    ?.replace(/[\s-]/g, "")
    .trim();
  return Boolean((gtin && /^\d{8,14}$/.test(gtin)) || row.mpn?.trim());
}

function issueKey(
  severity: ProductFeedIssueSeverity,
  code: string,
  title: string,
) {
  return `${severity}:${code}:${title}`;
}

export function auditProductFeedText(
  text: string,
  fileName: string,
  options: AuditOptions = {},
): ProductFeedAudit {
  const format = feedFormat(fileName);
  const byteLength = options.byteLength ?? new TextEncoder().encode(text).byteLength;
  if (byteLength > PRODUCT_FEED_MAX_BYTES) {
    throw new Error("This local preflight accepts feeds up to 5 MB.");
  }

  const rows = parseDelimitedProductFeed(text, delimiterFor(format, text));
  if (rows.length < 2) {
    throw new Error("The product feed needs one header row and at least one product row.");
  }

  const rawHeaders = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  const headers = rawHeaders.map(normalizeHeader);
  const productRows = rows.slice(1);
  if (productRows.length > PRODUCT_FEED_MAX_ROWS) {
    throw new Error("This local preflight accepts up to 50,000 product rows.");
  }

  const issueMap = new Map<string, MutableIssue>();
  const errorRows = new Set<number>();
  const warningRows = new Set<number>();

  function addIssue(
    severity: ProductFeedIssueSeverity,
    code: string,
    title: string,
    detail: string,
    rowNumber: number,
  ) {
    const key = issueKey(severity, code, title);
    const existing = issueMap.get(key) ?? {
      severity,
      code,
      title,
      detail,
      rows: new Set<number>(),
    };
    existing.rows.add(rowNumber);
    issueMap.set(key, existing);
    if (severity === "error") errorRows.add(rowNumber);
    else warningRows.add(rowNumber);
  }

  const duplicateHeaders = headers.filter(
    (header, index) => header && headers.indexOf(header) !== index,
  );
  for (const header of new Set(duplicateHeaders)) {
    addIssue(
      "error",
      `duplicate_header:${header}`,
      `Duplicate ${header} column`,
      "Each field can appear only once in the header row.",
      1,
    );
  }

  const gPrefixedHeaders = rawHeaders.filter((header) =>
    header.trim().toLowerCase().startsWith("g:"),
  );
  if (gPrefixedHeaders.length > 0) {
    addIssue(
      "error",
      "g_prefixed_headers",
      "Google XML-style headers are not supported",
      "Use lowercase underscore field names such as image_link instead of g:image_link.",
      1,
    );
  }

  const adsEligibilityColumn = headers.includes("is_ads_eligible")
    ? "is_ads_eligible"
    : headers.includes("is_eligible_ads")
      ? "is_eligible_ads"
      : null;
  const missingColumns: string[] = GOOGLE_CORE_COLUMNS.filter(
    (column) => !headers.includes(column),
  );
  if (!adsEligibilityColumn) missingColumns.push("is_ads_eligible");
  if (missingColumns.length > 0) {
    addIssue(
      "error",
      "missing_columns",
      "Required columns are missing",
      `Add ${missingColumns.join(", ")} to the header row.`,
      1,
    );
  }

  if (adsEligibilityColumn === "is_eligible_ads") {
    addIssue(
      "warning",
      "legacy_ads_eligibility",
      "Legacy Ads eligibility column",
      "OpenAI accepts is_eligible_ads as an alias, but new feeds should use is_ads_eligible.",
      1,
    );
  }

  if (format !== "txt") {
    const nonCanonical = rawHeaders.filter(
      (header, index) => header !== headers[index],
    );
    if (nonCanonical.length > 0) {
      addIssue(
        "warning",
        "noncanonical_headers",
        "Header names should be canonical",
        "Use lowercase underscore-separated field names for CSV and TSV uploads.",
        1,
      );
    }
  }

  const seenIds = new Map<string, number>();
  let adsEligibleRows = 0;
  const now = options.now ?? new Date();

  if (!errorRows.has(1)) productRows.forEach((values, productIndex) => {
    const rowNumber = productIndex + 2;
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
    );
    const rowErrorCountBefore = errorRows.has(rowNumber) ? 1 : 0;

    if (values.length !== headers.length) {
      addIssue(
        "error",
        "column_count",
        "Row does not match the header",
        "Every product row must contain the same number of fields as the header row.",
        rowNumber,
      );
    }

    for (const column of GOOGLE_CORE_COLUMNS) {
      if (!row[column]) {
        addIssue(
          "error",
          `missing_value:${column}`,
          `Missing ${column}`,
          `Every product row needs a nonempty ${column} value.`,
          rowNumber,
        );
      }
    }

    const id = row.id;
    if (id) {
      if (id.length > 100) {
        addIssue(
          "error",
          "id_length",
          "Product ID is too long",
          "Keep stable product or variant IDs at 100 characters or fewer.",
          rowNumber,
        );
      }
      const firstRow = seenIds.get(id);
      if (firstRow) {
        addIssue(
          "error",
          "duplicate_id",
          "Duplicate product ID",
          `Each product or variant needs a stable unique ID; this value first appeared on row ${firstRow}.`,
          rowNumber,
        );
      } else {
        seenIds.set(id, rowNumber);
      }
    }

    if (row.title?.length > 150) {
      addIssue(
        "error",
        "title_length",
        "Product title is too long",
        "Keep product titles at 150 characters or fewer.",
        rowNumber,
      );
    }
    if (row.description?.length > 5_000) {
      addIssue(
        "error",
        "description_length",
        "Product description is too long",
        "Keep product descriptions at 5,000 characters or fewer.",
        rowNumber,
      );
    }
    if (row.brand?.length > 70) {
      addIssue(
        "error",
        "brand_length",
        "Brand is too long",
        "Keep brand names at 70 characters or fewer.",
        rowNumber,
      );
    }

    for (const [field, value] of [
      ["link", row.link],
      ["image_link", row.image_link],
    ] as const) {
      if (value && !isPublicHttpUrl(value)) {
        addIssue(
          "error",
          `invalid_url:${field}`,
          `Invalid ${field}`,
          "Use a public HTTP or HTTPS URL without embedded credentials.",
          rowNumber,
        );
      }
    }

    const availability = row.availability?.toLowerCase();
    if (availability && !SUPPORTED_AVAILABILITY.has(availability)) {
      addIssue(
        "error",
        "availability",
        "Unsupported availability value",
        "Use in_stock, out_of_stock, backorder, or preorder.",
        rowNumber,
      );
    }
    if (
      (availability === "preorder" || availability === "backorder") &&
      !row.availability_date
    ) {
      addIssue(
        "error",
        "availability_date_missing",
        "Availability date is required",
        "Preorder and backorder products need availability_date.",
        rowNumber,
      );
    } else if (
      row.availability_date &&
      !isFutureDate(row.availability_date, now)
    ) {
      addIssue(
        "error",
        "availability_date_invalid",
        "Availability date must be in the future",
        "Use a valid future ISO 8601 date for availability_date.",
        rowNumber,
      );
    }

    const price = row.price ? parsePrice(row.price) : null;
    if (row.price && (!price || price.amount <= 0)) {
      addIssue(
        "error",
        "price",
        "Invalid price",
        "Use a positive amount followed by an uppercase three-letter currency code, for example 79.99 USD.",
        rowNumber,
      );
    }
    if (row.sale_price) {
      const salePrice = parsePrice(row.sale_price);
      if (
        !salePrice ||
        salePrice.amount <= 0 ||
        !price ||
        salePrice.currency !== price.currency ||
        salePrice.amount >= price.amount
      ) {
        addIssue(
          "error",
          "sale_price",
          "Invalid sale price",
          "sale_price must be positive, use the same currency, and be lower than price.",
          rowNumber,
        );
      }
    }

    if (!hasProductIdentifier(row)) {
      addIssue(
        "error",
        "identifier",
        "Product identifier is missing or invalid",
        "Provide a valid 8-14 digit GTIN or a nonempty MPN, or set identifier_exists to no only when the product genuinely has neither.",
        rowNumber,
      );
    }

    const adsEligible = adsEligibilityColumn
      ? row[adsEligibilityColumn]?.toLowerCase()
      : "";
    if (adsEligible !== "true") {
      addIssue(
        "error",
        "ads_eligibility",
        "Product is not enabled for Ads processing",
        "Set is_ads_eligible to true for every product that OpenAI Ads should process.",
        rowNumber,
      );
    }

    if (
      rowErrorCountBefore === 0 &&
      !errorRows.has(rowNumber) &&
      adsEligible === "true"
    ) {
      adsEligibleRows += 1;
    }
  });

  const issues = [...issueMap.values()]
    .map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      title: issue.title,
      detail: issue.detail,
      count: issue.rows.size,
      sampleRows: [...issue.rows].slice(0, 5),
    }))
    .sort(
      (left, right) =>
        (left.severity === right.severity
          ? 0
          : left.severity === "error"
            ? -1
            : 1) ||
        right.count - left.count ||
        left.title.localeCompare(right.title),
    );

  const hasFileError = errorRows.has(1);
  return {
    fileName,
    format,
    rowCount: productRows.length,
    adsEligibleRows,
    blockedRows: [...errorRows].filter((row) => row > 1).length,
    warningRows: [...warningRows].filter((row) => row > 1).length,
    verdict: hasFileError
      ? "invalid"
      : errorRows.size > 0
        ? "needs_work"
        : "ready",
    issues,
  };
}

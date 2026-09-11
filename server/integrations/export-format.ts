import ExcelJS from 'exceljs';

export type ExportColumn = { source: string; label: string };
export type ExportOptions = { columns?: ExportColumn[]; lineItems?: string; format: 'csv' | 'xlsx' | 'json' };
export type ExportRecord = {
  documentId: string;
  filename: string;
  runId: string;
  revision: number;
  approvalId?: string;
  correctionId?: string | null;
  values: Record<string, unknown>;
};

/** User strings always remain strings. Numeric values remain numeric. */
export function safeCell(value: unknown): string | number | boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /^[\s\u0000-\u001f]*[=+@-]/u.test(text) ? `'${text}` : text;
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) =>
    current && typeof current === 'object' && Object.hasOwn(current, key)
      ? (current as Record<string, unknown>)[key] : null, value);
}

function leafPaths(value: unknown, prefix = '', exclude?: string): string[] {
  if (prefix === exclude) return [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key, exclude));
  }
  return prefix ? [prefix] : [];
}

export function exportRows(records: ExportRecord[], options: ExportOptions) {
  const sources = [...new Set(records.flatMap(record =>
    leafPaths(record.values, '', options.lineItems)))];
  const itemPaths = options.lineItems ? [...new Set(records.flatMap(record => {
    const items = getPath(record.values, options.lineItems!);
    return Array.isArray(items) ? items.flatMap(item => leafPaths(item)) : [];
  }))] : [];
  const columns = options.columns?.length ? options.columns : [
    ...sources.map(source => ({ source, label: source })),
    ...itemPaths.map(source => ({ source: `$item.${source}`, label: `${options.lineItems}.${source}` })),
  ];
  const rows: Array<Array<string | number | boolean>> = [];
  for (const record of records) {
    const items = options.lineItems ? getPath(record.values, options.lineItems) : null;
    const expanded = Array.isArray(items) && items.length ? items : [null];
    if (rows.length + expanded.length > 100_000 || (rows.length + expanded.length) * columns.length > 2_000_000) {
      throw Object.assign(new Error('This export exceeds 100,000 rows or 2 million cells. Export a smaller selection.'), { statusCode: 413 });
    }
    for (const item of expanded) {
      rows.push(columns.map(column => {
        if (column.source === '$filename') return safeCell(record.filename);
        if (column.source === '$documentId') return record.documentId;
        if (column.source === '$runId') return record.runId;
        if (column.source === '$revision') return record.revision;
        if (column.source === '$approvalId') return record.approvalId || '';
        if (column.source.startsWith('$item.')) return safeCell(getPath(item, column.source.slice(6)));
        return safeCell(getPath(record.values, column.source));
      }));
    }
  }
  return { headers: columns.map(column => safeCell(column.label)), rows };
}

export async function renderExport(records: ExportRecord[], options: ExportOptions): Promise<{bytes: Buffer; mime: string; extension: string}> {
  if (options.format === 'json') {
    return {
      bytes: Buffer.from(JSON.stringify({ version: 1, documents: records }, null, 2)),
      mime: 'application/json', extension: 'json',
    };
  }
  const {headers, rows} = exportRows(records, options);
  if (options.format === 'csv') {
    const quote = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
    return {
      bytes: Buffer.from('\uFEFF' + [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n'),
      mime: 'text/csv; charset=utf-8', extension: 'csv',
    };
  }
  const book = new ExcelJS.Workbook();
  book.creator = 'Folio';
  const sheet = book.addWorksheet('Extracted data');
  sheet.addRow(headers);
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF6573D5'} };
  sheet.views = [{state: 'frozen', ySplit: 1}];
  sheet.columns.forEach(column => { column.width = 24; });
  return {
    bytes: Buffer.from(await book.xlsx.writeBuffer()),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx',
  };
}

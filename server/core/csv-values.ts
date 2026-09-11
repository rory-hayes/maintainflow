import type { PageText, ParserSchema, SchemaField } from '../../shared/types.js';

const limits = { pages: 30, sourceCharacters: 512 * 1024, cells: 20_000, values: 10_000, depth: 8 };

/** Exact serialized cells only: whitespace around a quoted token is not silently repaired. */
function quotedCells(pages: PageText[]): Map<string, string> | null {
  if (pages.length > limits.pages) return null;
  const quoted = new Map<string, string>();
  const decoded = new Set<string>();
  let characters = 0, cells = 0;
  for (const page of pages) {
    const text = page.text;
    characters += text.length;
    if (characters > limits.sourceCharacters) return null;
    let cursor = text.startsWith('\uFEFF') ? 1 : 0;
    while (cursor < text.length) {
      if (++cells > limits.cells) return null;
      const start = cursor;
      let value: string;
      if (text[cursor] === '"') {
        cursor++;
        let closed = false;
        while (cursor < text.length) {
          if (text[cursor] !== '"') { cursor++; continue; }
          if (text[cursor + 1] === '"') { cursor += 2; continue; }
          cursor++;
          closed = true;
          break;
        }
        if (!closed) return null;
        value = text.slice(start + 1, cursor - 1).replace(/""/g, '"');
        quoted.set(text.slice(start, cursor), value);
        if (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor])) return null;
      } else {
        while (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor])) {
          if (text[cursor] === '"') return null;
          cursor++;
        }
        value = text.slice(start, cursor);
      }
      decoded.add(value);
      if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
      else if (cursor < text.length) cursor++;
    }
  }
  // A value can be a serialized token in one cell and literal quoted text in another.
  // Without cell-level identity, retaining that value is safer than double decoding it.
  for (const value of decoded) quoted.delete(value);
  return quoted;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Prepare normalization input without changing the raw extraction or its evidence. */
export function decodeCsvRawValues(
  raw: Record<string, unknown>, schema: ParserSchema, pages: PageText[],
): Record<string, unknown> {
  const candidates = quotedCells(pages);
  if (!candidates?.size) return raw;
  const quoted = candidates;
  let visited = 0;
  const exceeded = Symbol('CSV value traversal limit');
  function record(values: Record<string, unknown>, fields: SchemaField[], depth: number): Record<string, unknown> {
    if (depth > limits.depth) throw exceeded;
    const byKey = new Map(fields.map(field => [field.key, field]));
    return Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (++visited > limits.values) throw exceeded;
      const field = byKey.get(key);
      if (!field) return [key, value];
      if (field.type === 'array' && Array.isArray(value)) {
        return [key, value.map(item => {
          if (++visited > limits.values) throw exceeded;
          return isRecord(item) ? record(item, field.fields || [], depth + 1) : item;
        })];
      }
      if (field.type === 'object' && isRecord(value)) return [key, record(value, field.fields || [], depth + 1)];
      return [key, typeof value === 'string' && field.type !== 'array' && field.type !== 'object'
        ? quoted.get(value) ?? value : value];
    }));
  }
  try { return record(raw, schema.fields, 0); }
  catch (error) { if (error === exceeded) return raw; throw error; }
}

import type {PageText,ParserSchema,SchemaField,ExtractionResult,Evidence} from '../../shared/types.js';
import {validateValues} from './schema.js';
import {normalizeWrittenDate} from './written-date.js';
const currencies=new Set(Intl.supportedValuesOf('currency'));
const escaped=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function normalizeValue(value:unknown,field:SchemaField,locale:string):unknown{
if(value===null||value===undefined||value==='')return field.default===undefined?null:field.default;
if(field.type==='array')return Array.isArray(value)?value.map(row=>Object.fromEntries((field.fields||[]).map(f=>[f.key,normalizeValue((row as any)?.[f.key],f,locale)]))):value;
if(field.type==='object')return typeof value==='object'?Object.fromEntries((field.fields||[]).map(f=>[f.key,normalizeValue((value as any)[f.key],f,locale)])):value;
let str=String(value).trim();if(field.type==='string'||field.type==='multiline'){if(field.transform==='uppercase')str=str.toUpperCase();if(field.transform==='lowercase')str=str.toLowerCase();return str;}
if(field.type==='number'||field.type==='currency'){if(typeof value==='number')return value;const parts=new Intl.NumberFormat(locale).formatToParts(12345.6),decimal=parts.find(p=>p.type==='decimal')?.value||'.',group=parts.find(p=>p.type==='group')?.value||',';const negative=/^\(.*\)$/.test(str);if(negative)str=str.slice(1,-1);if(field.type==='currency')str=str.replace(/\p{Sc}/gu,'').replace(/\b[A-Z]{3}\b/g,code=>currencies.has(code)?'':code);str=str.replace(new RegExp(escaped(group),'g'),'').replace(decimal,'.').replace(/\s/g,'');if(!str||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(str))return String(value);const n=Number(str);return Number.isFinite(n)?(negative?-n:n):String(value);}
if(field.type==='boolean'){if(/^(true|yes|1)$/i.test(str))return true;if(/^(false|no|0)$/i.test(str))return false;return str;}
if(field.type==='date'){if(/^\d{4}-\d{2}-\d{2}$/.test(str))return str;const m=str.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);if(m){const us=/^en-US/i.test(locale);return `${m[3]}-${(us?m[1]:m[2]).padStart(2,'0')}-${(us?m[2]:m[1]).padStart(2,'0')}`;}return normalizeWrittenDate(str,locale)??str;}
return str;
}
function cells(line:string):string[]{if(line.includes('|'))return line.split('|').map(v=>v.trim()).filter((v,i,a)=>v||i>0&&i<a.length-1);if(line.includes('\t'))return line.split('\t').map(v=>v.trim());const result:string[]=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const char=line[i];if(char==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){result.push(value.trim());value='';}else value+=char;}result.push(value.trim());return result;}
export const rulesEngine = Object.freeze({ engine: 'text-anchors', model: 'deterministic-v2' });
const multilineLimits = { lines: 100, characters: 65_536 };

function captureMultiline(
  lines: string[], start: number, firstValue: string, boundary: (line: string) => boolean,
) {
  const values = firstValue.trim() ? [firstValue] : [];
  const source = [lines[start]];
  let characters = values[0]?.length || 0;
  let limited = characters > multilineLimits.characters;
  for (let index = start + 1; !limited && index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || boundary(line)) break;
    const addedCharacters = line.length + (values.length ? 1 : 0);
    if (values.length >= multilineLimits.lines || characters + addedCharacters > multilineLimits.characters) {
      limited = true;
      break;
    }
    values.push(line);
    source.push(line);
    characters += addedCharacters;
  }
  // Do not present a silently truncated value as a complete extraction. The source
  // remains available for review and the caller records a specific limit issue.
  return { value: limited || !values.length ? null : values.join('\n'), text: source.join('\n'), limited };
}

export function extractRules(pages: PageText[], schema: ParserSchema, locale: string, templates: any[] = []): ExtractionResult {
  const rawValues: Record<string, unknown> = {}, evidence: Record<string, Evidence[]> = {};
  const text = pages.map(page => page.text).join('\n');
  const matchingTemplates = templates.filter(t => t.enabled && (!t.match_text || text.includes(t.match_text)));
  const template = matchingTemplates[0];
  const extractionIssues: ExtractionResult['issues'] = [];
  const descriptors: { field: SchemaField; key: string; anchor: string; matcher: RegExp }[] = [];
  const collect = (fields: SchemaField[], prefix = '') => {
    for (const field of fields) {
      const key = prefix + field.key;
      const rule = template?.rules?.find((r: any) => r.field === key);
      const anchor = rule?.anchor || field.anchor || field.label;
      descriptors.push({ field, key, anchor, matcher: new RegExp(`^\\s*${escaped(anchor)}\\s*(?::|=)\\s*(.*)$`, 'i') });
      if (field.fields) collect(field.fields, key + '.');
    }
  };
  collect(schema.fields);
  const sameHeader = (value: string, field: SchemaField, anchor?: string) =>
    [field.key, field.label, field.anchor, anchor].some(candidate => candidate?.toLowerCase() === value.toLowerCase());
  const tableBoundary = (line: string) => {
    const headers = cells(line);
    if (headers.length < 2) return false;
    // Pipe/tab rows are explicit structure. Ordinary comma-bearing prose is kept
    // unless its cells are recognizable schema column headers.
    if (line.includes('|') || line.includes('\t')) return headers.filter(value => value.trim()).length >= 2;
    if (descriptors.some(({ field }) => field.type === 'array' && field.fields?.length &&
      field.fields.every(child => headers.some(value => sameHeader(value, child))))) return true;
    return headers.filter(value => descriptors.some(({ field, anchor }) =>
      !['array', 'object'].includes(field.type) && sameHeader(value, field, anchor))).length >= 2;
  };
  const boundary = (line: string) => descriptors.some(descriptor => descriptor.matcher.test(line)) || tableBoundary(line);
  const walk = (fields: SchemaField[], target: Record<string, unknown>, prefix = '') => {
    for (const field of fields) {
      const key = prefix + field.key;
      const { anchor, matcher } = descriptors.find(descriptor => descriptor.key === key)!;
      let value: unknown = null;
      let multilineCaptured = false;
      const found: Evidence[] = [];
      if (field.type === 'object') {
        const nested: Record<string, unknown> = {};
        walk(field.fields || [], nested, key + '.');
        target[field.key] = nested;
        continue;
      }
      for (const page of pages) {
        const lines = page.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(matcher);
          if (field.type === 'array') {
            const h = match ? i + 1 : i;
            const headers = cells(lines[h] || '');
            const child = field.fields || [];
            const indexes = child.map(f => headers.findIndex(v => sameHeader(v, f)));
            if (indexes.some(v => v < 0) || headers.length < child.length) continue;
            const rows: Record<string, unknown>[] = [];
            for (let r = h + 1; r < lines.length; r++) {
              if (!lines[r].trim()) break;
              const rowCells = cells(lines[r]);
              if (rowCells.length < headers.length) break;
              rows.push(Object.fromEntries(child.map((f, k) => [f.key, rowCells[indexes[k]] ?? null])));
              found.push({ page: page.page, text: lines[r] });
              if (rows.length >= 1000) break;
            }
            if (rows.length) { value = Array.isArray(value) ? [...value, ...rows] : rows; i = h + rows.length; }
          } else if (field.type === 'multiline' && match && !multilineCaptured && value === null) {
            const capture = captureMultiline(lines, i, match[1], boundary);
            value = capture.value;
            multilineCaptured = true;
            found.push({ page: page.page, text: capture.text });
            if (capture.limited) extractionIssues.push({ field: key, code: 'multiline_limit', message: `${field.label} exceeds 100 lines or 65,536 characters. Review the source and enter the complete value.` });
          } else if (match && value === null && field.type !== 'multiline') {
            value = match[1].trim() || null;
            found.push({ page: page.page, text: lines[i] });
          } else if (value === null && !multilineCaptured) {
            const headers = cells(lines[i]);
            const index = headers.findIndex(v => [field.key, anchor, field.label].some(a => a && a.toLowerCase() === v.toLowerCase()));
            if (headers.length > 1 && index >= 0 && lines[i + 1]) {
              const row = cells(lines[i + 1]);
              if (row.length === headers.length) {
                value = row[index] || null;
                if (field.type === 'multiline') multilineCaptured = true;
                found.push({ page: page.page, text: lines[i] + '\n' + lines[i + 1] });
              }
            }
          }
        }
      }
      target[field.key] = value;
      if (found.length) evidence[key] = found;
    }
  };
  walk(schema.fields, rawValues);
  const normalizedValues = Object.fromEntries(schema.fields.map(field => [field.key, normalizeValue(rawValues[field.key], field, locale)]));
  const issues = [...validateValues(normalizedValues, schema), ...extractionIssues];
  if (matchingTemplates.length > 1) issues.push({ field: '_template', code: 'multiple_templates', message: 'Several templates matched. The oldest matching template was used; refine exact match text.' });
  if (templates.some(t => t.enabled) && !template) issues.push({ field: '_template', code: 'no_template', message: 'No saved template matched. Field-label anchors were used.' });
  return { rawValues, normalizedValues, evidence, issues, ...rulesEngine };
}

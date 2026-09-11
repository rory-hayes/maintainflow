import type {SchemaField} from '../../../shared/types';

export function emptyFieldValue(field:SchemaField):unknown {
  if(field.default!==undefined)return structuredClone(field.default);
  if(field.type==='array')return [];
  if(field.type==='object')return Object.fromEntries((field.fields||[]).map(child=>[child.key,emptyFieldValue(child)]));
  return null;
}

// Keep input drafts as text while typing, then normalize once at the save boundary.
export function normalizeEditorValues(values:Record<string,unknown>,fields:SchemaField[]):Record<string,unknown> {
  return Object.fromEntries(fields.map(field=>[field.key,normalizeValue(values[field.key],field)]));
}
function normalizeValue(value:unknown,field:SchemaField):unknown {
  if(value===null||value===undefined||value==='')return null;
  if(field.type==='number'||field.type==='currency'){
    if(typeof value!=='string')return value;
    const trimmed=value.trim();
    if(!trimmed)return null;
    const numeric=Number(trimmed);
    return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed)&&Number.isFinite(numeric)?numeric:value;
  }
  if(field.type==='array'&&Array.isArray(value))return value.map(row=>row&&typeof row==='object'&&!Array.isArray(row)?normalizeEditorValues(row as Record<string,unknown>,field.fields||[]):row);
  if(field.type==='object'&&typeof value==='object'&&!Array.isArray(value))return normalizeEditorValues(value as Record<string,unknown>,field.fields||[]);
  return value;
}

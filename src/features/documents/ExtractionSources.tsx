import type { Evidence, SchemaField } from '../../../shared/types';

type EvidenceMap = Record<string, Evidence[]>;
type PageHandler = (page: number) => void;

export function SourceQuotes({ items = [], onPage }: { items?: Evidence[]; onPage: PageHandler }) {
  const quotes = Array.isArray(items) ? items : [];
  return <div className="source-quotes">{quotes.map((item, index) =>
    <button key={index} className="evidence-link" type="button" onClick={() => onPage(item.page)}>
      <span>{item.source === 'model-visual' ? 'AI-read source' : 'Source'} · Page {item.page}: </span>
      <span className="source-quote-text">{item.text}</span>
    </button>
  )}</div>;
}

function ownValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function FieldSource({ field, value, path, evidence, onPage }: {
  field: SchemaField; value: unknown; path: string; evidence: EvidenceMap; onPage: PageHandler;
}) {
  const quotes = Object.hasOwn(evidence, path) ? evidence[path] : [];
  const children = field.fields || [];
  if (field.type === 'array') {
    const rows = Array.isArray(value) ? value : [];
    return <li className="original-source-branch" data-source-path={path}>
      <strong>{field.label}</strong>
      {quotes.length > 0 && <div className="original-source-group-quotes"><p>Table-level source quotes</p><SourceQuotes items={quotes} onPage={onPage} /></div>}
      {rows.length ? <ol className="original-source-rows">{rows.map((row, index) =>
        <li key={index} data-original-row={index + 1}>
          <p className="original-source-row-label">Original row {index + 1}</p>
          <ul className="original-source-fields">{children.map(child => <FieldSource key={child.key} field={child} value={ownValue(row, child.key)} path={`${path}[${index}].${child.key}`} evidence={evidence} onPage={onPage} />)}</ul>
        </li>
      )}</ol> : <p className="original-source-empty">{value == null ? 'Not found in the original extraction.' : 'No rows in the original extraction.'}</p>}
    </li>;
  }
  if (field.type === 'object') {
    return <li className="original-source-branch" data-source-path={path}>
      <strong>{field.label}</strong>
      {quotes.length > 0 && <div className="original-source-group-quotes"><p>Object-level source quotes</p><SourceQuotes items={quotes} onPage={onPage} /></div>}
      {value == null ? <p className="original-source-empty">Not found in the original extraction.</p> :
        <ul className="original-source-fields">{children.map(child => <FieldSource key={child.key} field={child} value={ownValue(value, child.key)} path={`${path}.${child.key}`} evidence={evidence} onPage={onPage} />)}</ul>}
    </li>;
  }
  return <li className="original-source-leaf" data-source-path={path}>
    <strong>{field.label}</strong>
    <p className="original-source-value">{value == null ? 'Not found in the original extraction.' : <><span>Extracted: </span>{value === '' ? '(Empty text)' : String(value)}</>}</p>
    {quotes.length ? <SourceQuotes items={quotes} onPage={onPage} /> : <p className="original-source-empty">No source quote recorded.</p>}
  </li>;
}

/** Never accepts edited values: corrections have no row lineage to bind source quotes to. */
export default function OriginalExtractionSources({ field, rawValues, evidence, onPage }: {
  field: SchemaField; rawValues: Record<string, unknown>; evidence: EvidenceMap; onPage: PageHandler;
}) {
  return <details className="original-extraction-sources">
    <summary>Original extraction sources <span>· {field.label}</span></summary>
    <p className="original-source-explanation">These values and row numbers belong to this extraction run. Your corrections do not change this source record.</p>
    <ul className="original-source-fields original-source-root"><FieldSource field={field} value={ownValue(rawValues, field.key)} path={field.key} evidence={evidence} onPage={onPage} /></ul>
  </details>;
}

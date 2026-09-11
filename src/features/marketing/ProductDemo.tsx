import { useId, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { ExtractedFields, InvoiceSample, invoiceJson } from './SampleDocument';

export function moveTabFocus(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  select: (index: number) => void,
) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % count;
  else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  else return;
  event.preventDefault();
  select(next);
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons?.[next]?.focus();
}

export default function ProductDemo() {
  const [selected, setSelected] = useState(0);
  const id = useId();
  return (
    <div className="marketing-product-demo">
      <div className="marketing-demo-toolbar">
        <h3><FileText size={23} strokeWidth={1.8} /> Invoice sample</h3>
        <div className="marketing-demo-tabs" role="tablist" aria-label="Sample view">
          {['Document', 'Results'].map((label, index) => (
            <button key={label} type="button" role="tab" aria-selected={selected === index} tabIndex={selected === index ? 0 : -1}
              id={`${id}-tab-${index}`} aria-controls={`${id}-panel`}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => moveTabFocus(event, index, 2, setSelected)}>{label}</button>
          ))}
        </div>
        <span className="marketing-sample-label">Synthetic sample</span>
      </div>
      <div className="marketing-demo-body">
        <div className="marketing-demo-document" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected}`} tabIndex={0}>
          {selected === 0 ? <InvoiceSample /> : (
            <div className="marketing-json-preview">
              <div className="marketing-json-header"><span>invoice.json</span><span>Structured output</span></div>
              <pre><code>{JSON.stringify(invoiceJson, null, 2)}</code></pre>
            </div>
          )}
        </div>
        <div className="marketing-demo-results">
          <h4 className="sr-only">Extracted fields</h4>
          <ExtractedFields />
          <Link className="button primary marketing-cta" to="/sign-up?sample=invoice">Open sample</Link>
        </div>
      </div>
    </div>
  );
}

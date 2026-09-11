import { useId, useState } from 'react';
import { FilePenLine, FileSearch, FileText, Table2 } from 'lucide-react';
import { InvoiceSample } from './SampleDocument';
import { moveTabFocus } from './ProductDemo';

const cases = [
  { title: 'Invoices', heading: 'Fields that fit your work.', body: 'Capture invoice numbers, dates, suppliers and line items. Keep identifiers intact and review missing values.' },
  { title: 'Receipts', heading: 'Every small detail, in order.', body: 'Pull out the merchant, purchase date, currency and amount. Keep a structured record beside the original receipt.' },
  { title: 'Purchase orders', heading: 'Order details you can work with.', body: 'Capture order references, delivery details and ordered items. Keep quantities and prices together in a table.' },
  { title: 'Lead emails', heading: 'From an enquiry to a clear record.', body: 'Extract contact details, company names and requests from email text. Define the details your next step needs.' },
  { title: 'Custom documents', heading: 'Your document. Your fields.', body: 'Start with a custom schema for your own workflow. Add field instructions, data types and validation requirements.' },
];

const features = [
  { Icon: FilePenLine, title: 'Your schema, your rules', body: 'Name fields, add instructions and choose data types.' },
  { Icon: FileSearch, title: 'Source evidence alongside values', body: 'Check extracted text against the original document.' },
  { Icon: Table2, title: 'Tables stay structured', body: 'Review and export repeated line items.' },
];

function CaseDocument({ selected }: { selected: number }) {
  if (selected === 0) return <InvoiceSample compact />;
  if (selected === 1) return (
    <article className="sample-document sample-receipt" aria-label="Synthetic receipt">
      <h3>Corner Café</h3><p>Synthetic receipt · 6 September 2026</p><hr />
      <div><span>Flat white</span><span>€3.80</span></div><div><span>Almond croissant</span><span>€4.20</span></div>
      <hr /><div className="sample-receipt-total"><strong>Total</strong><strong>€8.00</strong></div><p>EUR · Card payment</p>
    </article>
  );
  if (selected === 2) return (
    <article className="sample-document" aria-label="Synthetic purchase order">
      <div className="sample-document-heading"><div><h3>Northstar Office</h3><p>Synthetic purchase order</p></div><div className="sample-document-number"><strong>PO-2048</strong><span>2026-09-01</span></div></div>
      <p className="sample-recipient">Deliver to: Dublin office</p>
      <table className="sample-invoice-table"><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Amount</th></tr></thead><tbody><tr><td>Desk lamps</td><td>10</td><td>€240.00</td></tr><tr><td>Monitor stands</td><td>5</td><td>€175.00</td></tr></tbody><tfoot><tr><th scope="row" colSpan={2}>Total</th><td>€415.00</td></tr></tfoot></table>
    </article>
  );
  if (selected === 3) return (
    <article className="sample-document sample-email" aria-label="Synthetic lead email">
      <p className="sample-email-label">Synthetic email</p><h3>Enquiry: office supplies</h3>
      <dl><div><dt>From</dt><dd>alex@example.com</dd></div><div><dt>Subject</dt><dd>September order enquiry</dd></div></dl>
      <p>Hello,</p><p>I'm Alex from Northstar Office. We're looking for a quote for 20 desk lamps for our new office.</p><p>Please send the details to alex@example.com.</p><p>Thanks,<br />Alex</p>
    </article>
  );
  return (
    <article className="sample-document sample-custom" aria-label="Example custom schema">
      <p className="sample-email-label">Illustrative schema</p><h3>The fields you need</h3>
      <div><span>reference_id</span><em>Text</em></div><div><span>document_date</span><em>Date</em></div><div><span>amount</span><em>Currency</em></div><div><span>approved</span><em>Boolean</em></div><div><span>items</span><em>Table</em></div>
      <p>Add instructions to help each field find its place.</p>
    </article>
  );
}

export default function UseCases() {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const useCase = cases[selected];
  return (
    <section className="marketing-section marketing-use-cases marketing-container" id="product" aria-labelledby="use-cases-title">
      <div className="marketing-section-intro">
        <h2 id="use-cases-title">Different documents.<br />One clear workflow.</h2>
        <p>Set up a parser for each kind of document. Choose the fields you need and keep the output consistent.</p>
      </div>
      <div className="marketing-use-case-tabs" role="tablist" aria-label="Document use cases">
        {cases.map((item, index) => <button type="button" key={item.title} role="tab" aria-selected={selected === index} tabIndex={selected === index ? 0 : -1}
          id={`${id}-tab-${index}`} aria-controls={`${id}-panel`} onClick={() => setSelected(index)}
          onKeyDown={(event) => moveTabFocus(event, index, cases.length, setSelected)}>{item.title}</button>)}
      </div>
      <div className="marketing-use-case-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected}`}>
        <div className="marketing-use-case-document"><CaseDocument selected={selected} /></div>
        <div className="marketing-use-case-details">
          <h3>{useCase.heading}</h3><p>{useCase.body}</p>
          <div className="marketing-feature-list">
            {features.map(({ Icon, title, body }) => <div className="marketing-feature-row" key={title}><Icon size={35} strokeWidth={1.5} /><div><h4>{title}</h4><p>{body}</p></div></div>)}
          </div>
        </div>
      </div>
      <p className="marketing-format-note"><FileText size={24} strokeWidth={1.6} />Start with PDF, PNG, JPEG, EML or text.</p>
    </section>
  );
}

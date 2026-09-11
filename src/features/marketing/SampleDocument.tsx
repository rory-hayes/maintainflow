type InvoiceProps = { compact?: boolean };

export function InvoiceSample({ compact = false }: InvoiceProps) {
  return (
    <article className={`sample-document ${compact ? 'sample-document-compact' : ''}`} aria-label="Synthetic Northstar Office invoice">
      <div className="sample-document-heading">
        <div><h3>Northstar Office</h3><p>Synthetic document</p></div>
        <div className="sample-document-number"><strong>INVOICE</strong><span>INV-1042</span><span>Date: 2026-09-01</span></div>
      </div>
      <table className="sample-invoice-table">
        <caption className="sr-only">Invoice line items</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Amount</th></tr></thead>
        <tbody>
          <tr><td>Desk supplies</td><td>2</td><td>€85.00</td><td>€170.00</td></tr>
          <tr><td>Notebook sets</td><td>4</td><td>€19.60</td><td>€78.40</td></tr>
        </tbody>
        <tfoot><tr><th scope="row" colSpan={3}>Total</th><td>€248.40</td></tr></tfoot>
      </table>
      <p className="sample-document-note">Thank you for your order.</p>
    </article>
  );
}

export function ExtractedFields({ minimal = false }: { minimal?: boolean }) {
  const fields = minimal
    ? [['Supplier', 'Northstar Office'], ['Invoice no.', 'INV-1042'], ['Total', '€248.40']]
    : [['Supplier', 'Northstar Office'], ['Invoice number', 'INV-1042'], ['Date', '2026-09-01'], ['Currency', 'EUR'], ['Total', '€248.40']];

  return (
    <dl className={minimal ? 'hero-extracted-list' : 'demo-extracted-list'}>
      {fields.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export const invoiceJson = {
  supplier: 'Northstar Office',
  invoice_number: 'INV-1042',
  invoice_date: '2026-09-01',
  currency: 'EUR',
  total: 248.4,
  line_items: [
    { description: 'Desk supplies', quantity: 2, unit_price: 85, amount: 170 },
    { description: 'Notebook sets', quantity: 4, unit_price: 19.6, amount: 78.4 },
  ],
};

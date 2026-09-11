import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ErrorState, Loading, PageHeader, Tabs, dateTime } from '../../components/ui';
import { useData } from '../../lib/api';
import BillingPanel from './BillingPanel';
import './settings.css';

type UsageData = {
  plan: { name: string; monthlyPages: number; maxConcurrent: number; maxParsers: number };
  usage: { pages: number; events: number; documents: number; needsReview: number; processed: number; failed: number; costUsd: number };
  ledger: { id: string; documentId: string | null; event: string; pages: number; createdAt: string }[];
  billingRule: string;
};

export default function Usage() {
  const query = useData<UsageData>('/api/workspace/usage', true);
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => params.has('checkout') ? 'Billing' : 'Usage');
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const { plan, usage, ledger, billingRule } = query.data;
  const percent = plan.monthlyPages > 0 ? Math.min(100, usage.pages / plan.monthlyPages * 100) : 0;
  return (
    <div className="workspace-usage">
      <PageHeader title="Usage & billing" description="See your workspace allowance, recorded usage and billing setup." />
      <Tabs items={['Usage', 'Billing']} value={tab} onChange={setTab} />
      {tab === 'Billing' ? <BillingPanel /> : <>
        <section className="usage-summary" aria-labelledby="usage-allowance-title"><p className="small">{plan.name}</p><h2 id="usage-allowance-title">{usage.pages.toLocaleString('en-IE')} <small>/ {plan.monthlyPages.toLocaleString('en-IE')} pages this month</small></h2><div className="usage-meter" role="meter" aria-label="Monthly page allowance used" aria-valuemin={0} aria-valuemax={plan.monthlyPages} aria-valuenow={usage.pages}><span style={{ width: `${percent}%` }} /></div><p className="small muted">{Math.max(0, plan.monthlyPages - usage.pages).toLocaleString('en-IE')} pages remaining · {plan.maxConcurrent} concurrent processing jobs · Up to {plan.maxParsers} active parsers</p></section>
        <div className="usage-detail-rail"><div><strong>{usage.documents}</strong><span>Documents stored</span></div><div><strong>{usage.needsReview}</strong><span>Needs review</span></div><div><strong>{usage.failed}</strong><span>Failed documents</span></div><div><strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4 }).format(usage.costUsd)}</strong><span>Estimated model cost</span></div></div>
        <p className="small muted settings-bottom-note">Estimates cover recorded successful runs and are separate from your page allowance. Charges for failed or canceled attempts may not be included. This is not a reconciliation of the provider’s bill.</p>
        <div className="settings-callout"><strong>How usage is counted</strong><p>{billingRule}</p></div>
        <section className="settings-subsection"><h2>Usage ledger</h2><p className="small muted">The latest 50 usage events, including earlier months.</p>{ledger.length ? <div className="table-wrap"><table className="usage-ledger-table"><thead><tr><th>Event</th><th>Document</th><th>Pages</th><th>Time</th></tr></thead><tbody>{ledger.map((event) => <tr key={event.id}><td>{event.event === 'reprocess' ? 'Manual reprocessing' : 'Document upload'}</td><td>{event.documentId ? <Link className="link" to={`/app/documents/${event.documentId}`}>{event.documentId.slice(0, 8)}</Link> : <span className="muted">Deleted document</span>}</td><td>{event.pages}</td><td>{dateTime(event.createdAt)}</td></tr>)}</tbody></table></div> : <div className="settings-empty"><h3>No usage recorded yet.</h3><p>Upload a document to start a persistent processing workflow.</p><Link className="button secondary" to="/app">Open documents</Link></div>}</section>
      </>}
    </div>
  );
}

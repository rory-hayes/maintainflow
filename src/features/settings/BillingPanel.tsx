import { useSearchParams } from 'react-router-dom';
import { CreditCard, ExternalLink } from 'lucide-react';
import { PLANS } from '../../../shared/plans';
import { Button, ErrorState, Loading, Notice, Status } from '../../components/ui';
import { post, useAction, useData } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { ProviderStatus } from '../integrations/types';

export default function BillingPanel() {
  const providers = useData<ProviderStatus>('/api/providers/status');
  const { data: session } = useSession();
  const action = useAction();
  const [params] = useSearchParams();
  const canManage = ['owner', 'admin'].includes(session?.workspace.role || '');

  async function openBilling(path: string, body?: unknown) {
    const result = await action.run(() => post<{ url: string; mode: 'test' }>(path, body), 'Opening Stripe test mode…');
    if (result?.url) window.location.assign(result.url);
  }

  async function changeMockPlan(planId?: string) {
    await action.run(() => post(planId ? '/api/billing/mock/plan' : '/api/billing/mock/cancel', planId ? { planId } : {}),
      planId ? 'Mock plan updated. No payment was made.' : 'Mock subscription canceled. Explore limits now apply; existing work is kept.');
  }

  if (providers.isPending) return <Loading />;
  if (providers.error || !providers.data) return <ErrorState error={providers.error} retry={() => void providers.refetch()} />;
  const stripe = providers.data.stripe;
  const isMock = stripe.mode === 'mock';
  return (
    <section className="billing-panel">
      <div className="settings-section-heading"><div><h2>{isMock ? 'Mock billing' : 'Billing connection'}</h2><p>{isMock ? 'Try plan changes using this development workspace.' : 'Test-mode subscriptions for this workspace.'}</p></div><CreditCard size={26} strokeWidth={1.5} /></div>
      <div className="settings-information">
        {isMock ? <strong>Mock mode · no payments</strong> : <Status value={stripe.configured ? 'configured' : 'setup_required'} />}
        <p>{isMock ? 'Selections persist and change your test page, parser and processing limits. Stripe is not contacted. No payment or real subscription is created.' : stripe.configured ? 'Stripe test mode is configured. Checkout and subscription state still need end-to-end verification.' : 'Stripe test billing is not configured. The plans below are illustrative; no live charges are enabled.'}</p>
      </div>
      {isMock ? <div className="settings-callout"><strong>Current allowance: {stripe.mockPlan?.name || session?.workspace.plan.name || 'Loading…'}</strong><p>Changes apply immediately. Downgrades keep existing documents and parsers; new uploads and parser creation follow the selected limits.</p>{stripe.mockPlan?.status === 'canceled' ? <p>The mock subscription is canceled.</p> : null}</div> : null}
      {!isMock && params.get('checkout') === 'returned' ? <div className="settings-callout">You returned from Checkout. The workspace plan updates after the signed subscription event is processed.</div> : null}
      {!isMock && params.get('checkout') === 'canceled' ? <div className="settings-callout">Checkout was canceled. Your current workspace allowance is shown in Usage.</div> : null}
      <Notice error={action.error} message={action.message} />
      <div className="plan-columns">
        {PLANS.map((plan) => <div key={plan.id}>
          <h3>{plan.name}</h3><h2>€{plan.monthlyPrice} <small>/ month{isMock ? ' · illustrative' : ''}</small></h2><p>{plan.monthlyPages.toLocaleString('en-IE')} pages / month</p>
          <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
          {plan.id === 'explore' ? <p className="small">{isMock ? 'Cancel a mock subscription to apply Explore limits.' : 'Free plan configuration. The local development allowance is separate.'}</p> : isMock ?
            <Button disabled={!canManage || action.busy || stripe.mockPlan?.id === plan.id} onClick={() => void changeMockPlan(plan.id)}>{stripe.mockPlan?.id === plan.id ? `Current mock plan: ${plan.name}` : `Use ${plan.name} mock plan`}</Button> :
            <Button disabled={!canManage || !stripe.configured || action.busy} onClick={() => void openBilling('/api/billing/checkout', { planId: plan.id })}>Test {plan.name} checkout</Button>}
        </div>)}
      </div>
      <div className="actions">
        {isMock ? <Button variant="secondary" disabled={!canManage || action.busy || stripe.mockPlan?.status !== 'active'} onClick={() => void changeMockPlan()}>Cancel mock subscription</Button> : <Button variant="secondary" disabled={!canManage || !stripe.configured || action.busy} onClick={() => void openBilling('/api/billing/portal')}><ExternalLink size={16} /> Open test billing portal</Button>}
      </div>
      {!canManage ? <p className="small muted settings-bottom-note">A workspace owner or administrator can manage billing.</p> : null}
      <p className="small muted settings-bottom-note">{isMock ? 'This preview simulates plan changes. No payments are taken; real billing will be enabled for the production release.' : 'A configured provider is separate from a verified checkout. Live payment keys are disabled in this build.'}</p>
    </section>
  );
}

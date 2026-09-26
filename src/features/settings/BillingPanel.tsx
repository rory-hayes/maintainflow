import { useSearchParams } from 'react-router-dom';
import { useLayoutEffect, useRef } from 'react';
import { CreditCard, ExternalLink } from 'lucide-react';
import { PLANS } from '../../../shared/plans';
import { commercialTerms } from '../../../shared/commercial';
import { monthlyAiSuggestionLimit } from '../../../shared/ai-suggestion-allowances';
import { Button, ErrorState, Loading, Notice, Status } from '../../components/ui';
import { post, useAction, useData } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { ProviderStatus } from '../integrations/types';
import CheckoutTermsRecords from './CheckoutTermsRecords';

export default function BillingPanel() {
  const providers = useData<ProviderStatus>('/api/providers/status');
  const { data: session } = useSession();
  const action = useAction();
  const [params] = useSearchParams();
  const canManage = ['owner', 'admin'].includes(session?.workspace.role || '');
  const generation=useRef(0);
  useLayoutEffect(()=>{generation.current++;return()=>{generation.current++;};},[session?.user.id,session?.workspace.id,session?.workspace.role,providers.data?.stripe.mode]);

  async function openBilling(path: string, body?: unknown) {
    const started=generation.current,expectedMode=providers.data?.stripe.mode;
    const result = await action.run(async()=>{
      const response=await post<{ url: string; mode: 'test'|'live' }>(path, body);
      if(response.mode!==expectedMode)throw new Error('The billing mode changed. Refresh this page before continuing.');
      return response;
    }, expectedMode==='live'?'Opening Stripe live billing…':'Opening Stripe test mode…');
    if (result?.url&&generation.current===started) window.location.assign(result.url);
  }

  async function changeMockPlan(planId?: string) {
    await action.run(() => post(planId ? '/api/billing/mock/plan' : '/api/billing/mock/cancel', planId ? { planId } : {}),
      planId ? 'Mock plan updated. No payment was made.' : 'Mock subscription canceled. Explore limits now apply; existing work is kept.');
  }

  if (providers.isPending) return <Loading />;
  if (providers.error || !providers.data) return <ErrorState error={providers.error} retry={() => void providers.refetch()} />;
  const stripe = providers.data.stripe;
  const isMock = stripe.mode === 'mock';
  const isLive = stripe.mode === 'live';
  return (
    <section className="billing-panel">
      <div className="settings-section-heading"><div><h2>{isMock ? 'Mock billing' : 'Billing connection'}</h2><p>{isMock ? 'Try plan changes using this development workspace.' : isLive?'Live subscriptions for this workspace.':'Test-mode subscriptions for this workspace.'}</p></div><CreditCard size={26} strokeWidth={1.5} /></div>
      <div className="settings-information">
        {isMock ? <strong>Mock mode · no payments</strong> : <><strong>{isLive?'Live mode · real payments':'Test mode · no real payments'}</strong><Status value={stripe.configured ? 'configured' : 'setup_required'} /></>}
        <p>{isMock ? 'Selections persist and change your test page, parser and processing limits. Stripe is not contacted. No payment or real subscription is created.' : isLive ? stripe.configured?'Live billing is configured. Confirming a paid subscription in Stripe Checkout can charge your payment method.':'Live billing is selected but setup is incomplete. Checkout is unavailable until the operator finishes configuration.' : stripe.configured ? 'Stripe test mode is configured. Checkout and subscription state still need end-to-end verification.' : 'Stripe test billing is not configured. The plans below are illustrative; no live charges are enabled.'}</p>
      </div>
      {isMock ? <div className="settings-callout"><strong>Current allowance: {stripe.mockPlan?.name || session?.workspace.plan.name || 'Loading…'}</strong><p>Changes apply immediately. Downgrades keep existing documents and parsers; new uploads and parser creation follow the selected limits.</p>{stripe.mockPlan?.status === 'canceled' ? <p>The mock subscription is canceled.</p> : null}</div> : null}
      {!isMock && params.get('checkout') === 'returned' ? <div className="settings-callout">You returned from Checkout. The workspace plan updates after the signed subscription event is processed.</div> : null}
      {!isMock && params.get('checkout') === 'canceled' ? <div className="settings-callout">Checkout was canceled. Your current workspace allowance is shown in Usage.</div> : null}
      <Notice error={action.error} message={action.message} />
      <div className="plan-columns">
        {PLANS.map((plan) => <div key={plan.id}>
          <h3>{plan.name}</h3><h2>€{plan.monthlyPrice} <small>/ month{isMock ? ' · illustrative' : ''}</small></h2><p>{plan.monthlyPages.toLocaleString('en-IE')} pages / month</p>
          <p className="small">{monthlyAiSuggestionLimit(plan.id)} AI field or split suggestions / month</p>
          <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
          {plan.id === 'explore' ? <p className="small">{isMock ? 'Cancel a mock subscription to apply Explore limits.' : 'Explore is the free plan. Your current allowance is shown in Usage.'}</p> : isMock ?
            <Button disabled={!canManage || action.busy || stripe.mockPlan?.id === plan.id} onClick={() => void changeMockPlan(plan.id)}>{stripe.mockPlan?.id === plan.id ? `Current mock plan: ${plan.name}` : `Use ${plan.name} mock plan`}</Button> :
            <Button disabled={!canManage || !stripe.configured || action.busy} onClick={() => void openBilling('/api/billing/checkout', { planId: plan.id })}>{isLive?'Choose':'Test'} {plan.name} {isLive?'plan':'checkout'}</Button>}
        </div>)}
      </div>
      <p className="small muted">{commercialTerms.allowance}</p>
      <p className="small muted">{commercialTerms.tax} {commercialTerms.refunds}</p>
      <div className="actions">
        {isMock ? <Button variant="secondary" disabled={!canManage || action.busy || stripe.mockPlan?.status !== 'active'} onClick={() => void changeMockPlan()}>Cancel mock subscription</Button> : <Button variant="secondary" disabled={!canManage || !stripe.configured || action.busy} onClick={() => void openBilling('/api/billing/portal')}><ExternalLink size={16} /> {isLive?'Open billing portal':'Open test billing portal'}</Button>}
      </div>
      {!canManage ? <p className="small muted settings-bottom-note">A workspace owner or administrator can manage billing.</p> : null}
      <p className="small muted settings-bottom-note">{isMock ? 'This preview simulates plan changes. No payments are taken.' : isLive?'Manage payment details and cancellation in the billing portal. Configuration alone does not confirm a successful payment; subscription changes appear after signed Stripe events are processed.':'A configured test provider is separate from a verified checkout. Test-mode actions do not create real payments.'}</p>
      {canManage&&session?<CheckoutTermsRecords key={`${session.user.id}:${session.workspace.id}:${session.workspace.role}`} workspace={session.workspace.id}/>:null}
    </section>
  );
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PLANS } from '../../shared/plans.js';
import { admins, requireActor, requireSession } from '../core/auth.js';
import { config } from '../core/config.js';
import { adminPool, audit, badRequest, notFound, transaction, withWorkspace } from '../core/db.js';

/** Explicit local opt-in; production cannot expose a mock entitlement mutation. */
export function mockBillingEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.NODE_ENV !== 'production' && environment.FOLIO_BILLING_MOCK === 'true';
}

export function requireRealBilling() {
  if (mockBillingEnabled()) badRequest('Stripe is disabled while local mock billing is enabled.', 409);
}

export async function mockBillingStatus(workspaceId: string) {
  const { rows: [workspace] } = await withWorkspace(workspaceId, c => c.query('select plan from workspaces where id=$1', [workspaceId]));
  if (!workspace) notFound('Workspace not found');
  return {
    configured: false, mode: 'mock' as const, verified: false,
    reason: 'Local mock billing is enabled. Plan changes only update this development workspace. No Stripe requests, payment or subscription verification occur.',
    mockPlan: workspace.plan.billingMode === 'mock' ? { id: workspace.plan.id as string, name: workspace.plan.name as string, status: workspace.plan.mockStatus as 'active' | 'canceled' } : null,
  };
}

export async function registerMockBilling(app: FastifyInstance) {
  async function change(request: Parameters<typeof requireActor>[0], planId: typeof PLANS[number]['id']) {
    const actor = await requireActor(request, { roles: admins }); requireSession(actor);
    if (!mockBillingEnabled()) badRequest('Local mock billing is disabled.', 404);
    const selected = PLANS.find(plan => plan.id === planId)!;
    // Workspace plan writes use the same privileged transaction boundary as real billing;
    // every read/write is explicitly bound to the authenticated workspace.
    return transaction(adminPool, async c => {
      // Match Checkout's lock and the quota lock used by parser creation and intake.
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`billing:${actor.workspaceId}`]);
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [actor.workspaceId]);
      const { rows: [workspace] } = await c.query('select plan from workspaces where id=$1 for update', [actor.workspaceId]);
      if (!workspace) notFound('Workspace not found');
      const linked = await c.query('select workspace_id from subscriptions where workspace_id=$1 and (customer_id is not null or subscription_id is not null) union all select workspace_id from billing_checkouts where workspace_id=$1', [actor.workspaceId]);
      if (linked.rowCount) badRequest('This workspace already has Stripe billing state. Use a separate development workspace for local mock billing.', 409);
      const status = planId === 'explore' ? 'canceled' : 'active';
      if (workspace.plan.billingMode === 'mock' && workspace.plan.id === planId && workspace.plan.mockStatus === status) return { mode: 'mock', changed: false, plan: workspace.plan };
      const plan = {
        id: selected.id, name: `${selected.name} (local mock)`, monthlyPages: selected.monthlyPages,
        maxParsers: selected.maxParsers, maxConcurrent: selected.maxConcurrent,
        maxBytes: config.maxBytes, maxPages: config.maxPages,
        billingMode: 'mock', mockStatus: status, mockChangedAt: new Date().toISOString(),
      };
      await c.query('update workspaces set plan=$2 where id=$1', [actor.workspaceId, JSON.stringify(plan)]);
      await audit(c, actor.workspaceId, actor.userId, status === 'canceled' ? 'billing.mock_canceled' : 'billing.mock_plan_changed', actor.workspaceId,
        { mode: 'mock', previousPlan: workspace.plan.id ?? null, plan: planId, status });
      // Downgrades preserve existing documents/parsers. New work follows the resulting limits.
      return { mode: 'mock', changed: true, plan };
    });
  }
  app.post('/api/billing/mock/plan', async request => {
    const { planId } = z.object({ planId: z.enum(['standard', 'team']) }).strict().parse(request.body);
    return change(request, planId);
  });
  app.post('/api/billing/mock/cancel', async request => {
    z.object({}).strict().parse(request.body);
    return change(request, 'explore');
  });
}

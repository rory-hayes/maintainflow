import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DocumentStatus } from '../../shared/types.js';

export interface DocumentEventInput {
  phase: 'processing' | 'export';
  state: DocumentStatus;
  operationId?: string;
  details?: { reason?: string; format?: string; approvalId?: string; runId?: string };
  createdAt?: Date | string;
}
const inputSchema = z.object({
  phase: z.enum(['processing', 'export']),
  state: z.enum(['received', 'queued', 'processing', 'needs_review', 'processed', 'exporting', 'exported', 'failed']),
  operationId: z.string().uuid().optional(),
  details: z.object({
    reason: z.string().max(500).optional(),
    format: z.enum(['csv', 'xlsx', 'json']).optional(),
    approvalId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
  }).strict().default({}),
  createdAt: z.union([z.date(), z.iso.datetime({ offset: true })]).optional(),
}).superRefine((event, context) => {
  const valid = event.phase === 'export' ? ['exporting', 'exported', 'failed'] : ['received', 'queued', 'processing', 'needs_review', 'processed', 'failed'];
  if (!valid.includes(event.state)) context.addIssue({ code: 'custom', message: 'The lifecycle state does not belong to this phase.' });
});

const publicColumns = 'id,phase,state,operation_id,created_at,details';
const publicEvent = (row: any) => ({
  id: row.id,
  phase: row.phase,
  state: row.state,
  operationId: row.operation_id,
  createdAt: row.created_at,
  details: row.details,
});

/** Called inside the operation's transaction; details must contain safe fixed explanations, not document values or raw errors. */
export async function appendDocumentEvent(c: PoolClient, workspaceId: string, documentId: string, input: DocumentEventInput) {
  const event = inputSchema.parse(input);
  const result = await c.query(
    `insert into document_events(workspace_id,document_id,phase,state,operation_id,details,created_at)
     values($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,clock_timestamp())) returning ${publicColumns}`,
    [workspaceId, documentId, event.phase, event.state, event.operationId ?? null, JSON.stringify(event.details), event.createdAt ?? null],
  );
  return publicEvent(result.rows[0]);
}

/** Sequence is internal ordering only and is never part of the API representation. */
export async function documentLifecycle(c: PoolClient, workspaceId: string, documentId: string) {
  const result = await c.query(
    `select ${publicColumns} from document_events where workspace_id=$1 and document_id=$2 order by sequence desc limit 200`,
    [workspaceId, documentId],
  );
  return result.rows.map(publicEvent);
}

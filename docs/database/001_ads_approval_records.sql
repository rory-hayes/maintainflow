create table if not exists ads_approval_records (
  id uuid primary key,
  account_id text not null,
  operator_id text not null,
  recommendation_id text not null,
  recommendation_title text not null,
  entity_id text not null,
  request_payload jsonb not null,
  rollback_payload jsonb not null,
  evidence_payload jsonb not null,
  safeguard text not null,
  status text not null check (
    status in (
      'pending',
      'applied',
      'failed',
      'reconciliation_required',
      'rollback_pending',
      'rolled_back',
      'rollback_failed',
      'rollback_reconciliation_required'
    )
  ),
  response_payload jsonb,
  error_message text,
  rollback_operator_id text,
  rollback_response_payload jsonb,
  rollback_error_message text,
  reconciled_by text,
  reconciled_at timestamptz,
  reconciliation_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  rolled_back_at timestamptz
);

alter table ads_approval_records
  add column if not exists rollback_operator_id text,
  add column if not exists rollback_response_payload jsonb,
  add column if not exists rollback_error_message text,
  add column if not exists reconciled_by text,
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation_note text;

alter table ads_approval_records
  drop constraint if exists ads_approval_records_status_check;

alter table ads_approval_records
  add constraint ads_approval_records_status_check check (
    status in (
      'pending',
      'applied',
      'failed',
      'reconciliation_required',
      'rollback_pending',
      'rolled_back',
      'rollback_failed',
      'rollback_reconciliation_required'
    )
  );

create index if not exists ads_approval_records_account_created_idx
  on ads_approval_records (account_id, created_at desc);

create index if not exists ads_approval_records_operator_created_idx
  on ads_approval_records (operator_id, created_at desc);

create index if not exists ads_approval_records_account_status_idx
  on ads_approval_records (account_id, status, created_at desc);

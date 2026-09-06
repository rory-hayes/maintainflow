-- Durable, tenant-bound approval notification delivery state. Recipient
-- addresses and rendered content are resolved only at send time and are never
-- persisted in this outbox.
alter table public.maintainflow_change_approval_requests
  add constraint maintainflow_change_approval_requests_id_organization_key
  unique (id, organization_id);

create table public.maintainflow_approval_notification_deliveries (
  id uuid primary key,
  approval_request_id uuid not null,
  organization_id uuid not null,
  event_type text not null check (
    event_type in (
      'review_requested',
      'approval_approved',
      'approval_changes_requested',
      'approval_cancelled'
    )
  ),
  recipient_operator_id text not null,
  recipient_membership_role_snapshot text not null check (
    recipient_membership_role_snapshot in ('owner', 'admin', 'analyst')
  ),
  approval_request_version bigint not null check (
    approval_request_version > 0
  ),
  channel text not null default 'email' check (channel = 'email'),
  provider text not null default 'resend' check (provider = 'resend'),
  template_version smallint not null default 1 check (template_version = 1),
  status text not null default 'queued' check (
    status in (
      'queued',
      'sending',
      'retry_scheduled',
      'provider_accepted',
      'delivered',
      'bounced',
      'complained',
      'suppressed',
      'permanent_failure',
      'cancelled'
    )
  ),
  attempt_count smallint not null default 0 check (
    attempt_count between 0 and 5
  ),
  next_attempt_at timestamptz default pg_catalog.statement_timestamp(),
  claim_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  first_attempted_at timestamptz,
  provider_message_id text,
  provider_accepted_at timestamptz,
  last_failure_code text check (
    last_failure_code is null
    or last_failure_code in (
      'identity_provider_unavailable',
      'recipient_unavailable',
      'provider_timeout',
      'provider_rate_limited',
      'provider_unavailable',
      'provider_rejected',
      'provider_configuration',
      'worker_lease_expired',
      'delivery_confirmation_missing'
    )
  ),
  last_failed_at timestamptz,
  provider_event_type text check (
    provider_event_type is null
    or provider_event_type in (
      'email.delivered',
      'email.bounced',
      'email.complained',
      'email.suppressed',
      'email.failed',
      'email.delivery_delayed'
    )
  ),
  provider_event_at timestamptz,
  cancellation_code text check (
    cancellation_code is null
    or cancellation_code in ('recipient_ineligible', 'account_offboarded')
  ),
  cancelled_at timestamptz,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint maintainflow_approval_delivery_request_scope_fkey
    foreign key (approval_request_id, organization_id)
    references public.maintainflow_change_approval_requests (
      id,
      organization_id
    )
    on delete cascade,
  constraint maintainflow_approval_delivery_event_recipient_key
    unique (approval_request_id, event_type, recipient_operator_id),
  check (char_length(recipient_operator_id) between 1 and 255),
  check (
    provider_message_id is null
    or char_length(provider_message_id) between 1 and 255
  ),
  check (
    (
      claim_id is null
      and claimed_at is null
      and claim_expires_at is null
    )
    or (
      claim_id is not null
      and claimed_at is not null
      and claim_expires_at is not null
      and claim_expires_at > claimed_at
    )
  ),
  check (
    (attempt_count = 0 and first_attempted_at is null)
    or (
      attempt_count between 1 and 5
      and first_attempted_at is not null
    )
  ),
  check (
    (provider_message_id is null and provider_accepted_at is null)
    or (provider_message_id is not null and provider_accepted_at is not null)
  ),
  check (
    (last_failure_code is null and last_failed_at is null)
    or (last_failure_code is not null and last_failed_at is not null)
  ),
  check (
    (provider_event_type is null and provider_event_at is null)
    or (provider_event_type is not null and provider_event_at is not null)
  ),
  check (
    (cancellation_code is null and cancelled_at is null)
    or (cancellation_code is not null and cancelled_at is not null)
  ),
  check (updated_at >= created_at),
  check (claimed_at is null or claimed_at >= created_at),
  check (
    first_attempted_at is null
    or first_attempted_at >= created_at
  ),
  check (provider_accepted_at is null or provider_accepted_at >= created_at),
  check (
    provider_event_at is null
    or provider_accepted_at is not null
  ),
  check (last_failed_at is null or last_failed_at >= created_at),
  check (cancelled_at is null or cancelled_at >= created_at),
  constraint maintainflow_approval_notification_deliveries_lifecycle_check
  check (
    (
      status = 'queued'
      and attempt_count = 0
      and next_attempt_at is not null
      and claim_id is null
      and provider_message_id is null
      and last_failure_code is null
      and provider_event_type is null
      and cancellation_code is null
    )
    or (
      status = 'sending'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is not null
      and provider_message_id is null
      and provider_event_type is null
      and cancellation_code is null
    )
    or (
      status = 'retry_scheduled'
      and attempt_count between 1 and 4
      and next_attempt_at is not null
      and claim_id is null
      and provider_message_id is null
      and last_failure_code is not null
      and provider_event_type is null
      and cancellation_code is null
    )
    or (
      status = 'provider_accepted'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is null
      and provider_message_id is not null
      and cancellation_code is null
      and (
        provider_event_type is null
        or provider_event_type = 'email.delivery_delayed'
      )
    )
    or (
      status = 'delivered'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is null
      and provider_message_id is not null
      and provider_event_type = 'email.delivered'
      and cancellation_code is null
    )
    or (
      status = 'bounced'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is null
      and provider_message_id is not null
      and provider_event_type = 'email.bounced'
      and cancellation_code is null
    )
    or (
      status = 'complained'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is null
      and provider_message_id is not null
      and provider_event_type = 'email.complained'
      and cancellation_code is null
    )
    or (
      status = 'suppressed'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is null
      and provider_message_id is not null
      and provider_event_type = 'email.suppressed'
      and cancellation_code is null
    )
    or (
      status = 'permanent_failure'
      and attempt_count between 1 and 5
      and next_attempt_at is null
      and claim_id is null
      and last_failure_code is not null
      and cancellation_code is null
      and (
        (
          provider_message_id is null
          and provider_event_type is null
        )
        or (
          provider_message_id is not null
          and (
            provider_event_type is null
            or provider_event_type in (
              'email.delivery_delayed',
              'email.failed'
            )
          )
        )
      )
    )
    or (
      status = 'cancelled'
      and next_attempt_at is null
      and claim_id is null
      and provider_message_id is null
      and provider_event_type is null
      and cancellation_code is not null
    )
  )
);

create index maintainflow_approval_notification_deliveries_due_idx
  on public.maintainflow_approval_notification_deliveries (
    next_attempt_at,
    created_at,
    id
  )
  where status in ('queued', 'retry_scheduled');

create index maintainflow_approval_notification_deliveries_claim_expiry_idx
  on public.maintainflow_approval_notification_deliveries (
    claim_expires_at,
    id
  )
  where status = 'sending';

create unique index maintainflow_approval_delivery_provider_message_idx
  on public.maintainflow_approval_notification_deliveries (
    provider,
    provider_message_id
  )
  where provider_message_id is not null;

-- PostgreSQL acquires an UPDATE target row before invoking its row trigger.
-- Runtime claim/finalize transactions must therefore handle one organization
-- at a time and pre-lock, in order: organization, recipient memberships,
-- approval requests by id, then delivery rows by id. The trigger repeats the
-- parent eligibility locks so their values remain stable until commit.
create function
  public.maintainflow_enforce_approval_notification_delivery()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_approval_notification_delivery$
declare
  approval_request public.maintainflow_change_approval_requests%rowtype;
  current_organization_type text;
  current_organization_status text;
  current_recipient_role text;
  database_now timestamptz := pg_catalog.statement_timestamp();
  expected_provider_event_type text;
  recipient_still_eligible boolean;
begin
  if tg_op = 'INSERT' then
    select organization.customer_type, organization.status, membership.role
      into current_organization_type,
        current_organization_status,
        current_recipient_role
    from public.maintainflow_organizations organization
    join public.maintainflow_organization_memberships membership
      on membership.organization_id = organization.id
      and membership.clerk_user_id = new.recipient_operator_id
    where organization.id = new.organization_id
    for share of organization, membership;

    if not found
      or current_organization_type <> 'agency'
      or current_organization_status <> 'active' then
      raise exception
        'Approval notifications require a current active agency member';
    end if;

    select request.*
      into approval_request
    from public.maintainflow_change_approval_requests request
    where request.id = new.approval_request_id
      and request.organization_id = new.organization_id
    for share;

    if not found then
      raise exception
        'Approval notification requires an exact organization-scoped request';
    end if;

    if new.recipient_membership_role_snapshot <> current_recipient_role then
      raise exception
        'Approval notification recipient role snapshot must be current';
    end if;

    if new.approval_request_version <> approval_request.version then
      raise exception
        'Approval notification version must match its request transition';
    end if;

    if new.event_type = 'review_requested' then
      if approval_request.status <> 'awaiting_approval'
        or new.recipient_operator_id = approval_request.requester_operator_id
        or current_recipient_role not in ('owner', 'admin') then
        raise exception
          'Review notifications require another current owner or admin';
      end if;
    elsif new.event_type = 'approval_approved' then
      if approval_request.status <> 'approved'
        or new.recipient_operator_id <>
          approval_request.requester_operator_id then
        raise exception
          'Approved notifications require the current-member requester';
      end if;
    elsif new.event_type = 'approval_changes_requested' then
      if approval_request.status <> 'changes_requested'
        or new.recipient_operator_id <>
          approval_request.requester_operator_id then
        raise exception
          'Changes-requested notifications require the current-member requester';
      end if;
    elsif new.event_type = 'approval_cancelled' then
      if approval_request.status <> 'cancelled'
        or new.recipient_operator_id <>
          approval_request.requester_operator_id
        or approval_request.decision_operator_id is null
        or approval_request.decision_operator_id =
          approval_request.requester_operator_id then
        raise exception
          'Cancelled notifications require cancellation by another operator';
      end if;
    else
      raise exception 'Unsupported approval notification event';
    end if;

    if new.channel <> 'email'
      or new.provider <> 'resend'
      or new.template_version <> 1
      or new.status <> 'queued'
      or new.attempt_count <> 0
      or new.next_attempt_at is distinct from database_now
      or new.claim_id is not null
      or new.claimed_at is not null
      or new.claim_expires_at is not null
      or new.first_attempted_at is not null
      or new.provider_message_id is not null
      or new.provider_accepted_at is not null
      or new.last_failure_code is not null
      or new.last_failed_at is not null
      or new.provider_event_type is not null
      or new.provider_event_at is not null
      or new.cancellation_code is not null
      or new.cancelled_at is not null
      or new.created_at is distinct from database_now
      or new.updated_at is distinct from database_now then
      raise exception
        'New approval notifications must start in the database-owned queue state';
    end if;

    return new;
  end if;

  if row(
    new.id,
    new.approval_request_id,
    new.organization_id,
    new.event_type,
    new.recipient_operator_id,
    new.recipient_membership_role_snapshot,
    new.approval_request_version,
    new.channel,
    new.provider,
    new.template_version,
    new.created_at
  ) is distinct from row(
    old.id,
    old.approval_request_id,
    old.organization_id,
    old.event_type,
    old.recipient_operator_id,
    old.recipient_membership_role_snapshot,
    old.approval_request_version,
    old.channel,
    old.provider,
    old.template_version,
    old.created_at
  ) then
    raise exception
      'Approval notification identity is immutable after creation';
  end if;

  if row(
    new.attempt_count,
    new.next_attempt_at,
    new.claimed_at,
    new.claim_expires_at,
    new.first_attempted_at,
    new.provider_accepted_at,
    new.last_failed_at,
    new.cancelled_at,
    new.updated_at
  ) is distinct from row(
    old.attempt_count,
    old.next_attempt_at,
    old.claimed_at,
    old.claim_expires_at,
    old.first_attempted_at,
    old.provider_accepted_at,
    old.last_failed_at,
    old.cancelled_at,
    old.updated_at
  ) then
    raise exception
      'Approval notification derived lifecycle fields use database time';
  end if;

  if old.status in ('queued', 'retry_scheduled')
    and new.status = 'sending' then
    if new.claim_id is null
      or new.claim_id is not distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception 'A notification claim may set only a fresh claim identity';
    end if;
    if old.attempt_count >= 5 then
      raise exception 'A notification cannot exceed five send attempts';
    end if;

    select organization.customer_type, organization.status, membership.role
      into current_organization_type,
        current_organization_status,
        current_recipient_role
    from public.maintainflow_organizations organization
    join public.maintainflow_organization_memberships membership
      on membership.organization_id = organization.id
      and membership.clerk_user_id = old.recipient_operator_id
    where organization.id = old.organization_id
    for share of organization, membership;

    if not found
      or current_organization_type <> 'agency'
      or current_organization_status <> 'active' then
      raise exception
        'Approval notification recipient is no longer eligible';
    end if;

    select request.*
      into approval_request
    from public.maintainflow_change_approval_requests request
    where request.id = old.approval_request_id
      and request.organization_id = old.organization_id
    for share;

    if not found then
      raise exception
        'Approval notification request is no longer available';
    end if;

    if old.event_type = 'review_requested' then
      if approval_request.status <> 'awaiting_approval'
        or approval_request.version <> old.approval_request_version
        or old.recipient_operator_id = approval_request.requester_operator_id
        or current_recipient_role not in ('owner', 'admin') then
        raise exception
          'Review notification recipient is no longer eligible';
      end if;
    elsif old.event_type = 'approval_approved' then
      if approval_request.status <> 'approved'
        or approval_request.version < old.approval_request_version
        or old.recipient_operator_id <>
          approval_request.requester_operator_id then
        raise exception
          'Approved notification recipient is no longer eligible';
      end if;
    elsif old.event_type = 'approval_changes_requested' then
      if approval_request.status <> 'changes_requested'
        or approval_request.version <> old.approval_request_version
        or old.recipient_operator_id <>
          approval_request.requester_operator_id then
        raise exception
          'Changes-requested notification recipient is no longer eligible';
      end if;
    elsif old.event_type = 'approval_cancelled' then
      if approval_request.status <> 'cancelled'
        or approval_request.version <> old.approval_request_version
        or old.recipient_operator_id <>
          approval_request.requester_operator_id
        or approval_request.decision_operator_id is null
        or approval_request.decision_operator_id =
          approval_request.requester_operator_id then
        raise exception
          'Cancelled notification recipient is no longer eligible';
      end if;
    else
      raise exception 'Unsupported approval notification event';
    end if;

    new.attempt_count := old.attempt_count + 1;
    new.next_attempt_at := null;
    new.claimed_at := database_now;
    new.claim_expires_at := database_now + interval '2 minutes';
    new.first_attempted_at := coalesce(
      old.first_attempted_at,
      database_now
    );
  elsif old.status in ('queued', 'retry_scheduled')
    and new.status = 'cancelled' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is null then
      raise exception
        'Pending notification cancellation may set only its cancellation code';
    end if;

    new.next_attempt_at := null;
    new.cancelled_at := database_now;
  elsif old.status = 'retry_scheduled'
    and old.last_failure_code in (
      'provider_timeout',
      'provider_unavailable',
      'worker_lease_expired'
    )
    and new.status = 'permanent_failure' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'An expired ambiguous retry may change only to permanent failure';
    end if;

    new.next_attempt_at := null;
    new.last_failed_at := database_now;
  elsif old.status = 'sending'
    and new.status = 'provider_accepted' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is null
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'Provider acceptance may set only the provider message identity';
    end if;

    new.next_attempt_at := null;
    new.claim_id := null;
    new.claimed_at := null;
    new.claim_expires_at := null;
    new.provider_accepted_at := database_now;
  elsif old.status = 'sending'
    and new.status = 'retry_scheduled' then
    if old.attempt_count >= 5
      or new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is null
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'A retry requires an active claim, remaining attempt, and safe failure code';
    end if;

    new.next_attempt_at := database_now + case old.attempt_count
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      when 3 then interval '15 minutes'
      else interval '1 hour'
    end;
    new.claim_id := null;
    new.claimed_at := null;
    new.claim_expires_at := null;
    new.last_failed_at := database_now;
  elsif old.status = 'sending'
    and new.status = 'permanent_failure' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is null
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'Permanent send failure requires the active claim and a safe failure code';
    end if;

    new.next_attempt_at := null;
    new.claim_id := null;
    new.claimed_at := null;
    new.claim_expires_at := null;
    new.last_failed_at := database_now;
  elsif old.status = 'sending'
    and new.status = 'cancelled' then
    if (
        new.claim_id is not null
        and new.claim_id is distinct from old.claim_id
      )
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type is distinct from old.provider_event_type
      or new.provider_event_at is distinct from old.provider_event_at
      or new.cancellation_code is null then
      raise exception
        'Send cancellation may set only its cancellation code';
    end if;

    if new.cancellation_code = 'account_offboarded' then
      if database_now < old.claim_expires_at then
        raise exception
          'Account offboarding cannot cancel an active send claim';
      end if;
    elsif new.cancellation_code = 'recipient_ineligible' then
      recipient_still_eligible := false;
      select organization.customer_type, organization.status, membership.role
        into current_organization_type,
          current_organization_status,
          current_recipient_role
      from public.maintainflow_organizations organization
      join public.maintainflow_organization_memberships membership
        on membership.organization_id = organization.id
        and membership.clerk_user_id = old.recipient_operator_id
      where organization.id = old.organization_id
      for share of organization, membership;

      if found
        and current_organization_type = 'agency'
        and current_organization_status = 'active' then
        select request.*
          into approval_request
        from public.maintainflow_change_approval_requests request
        where request.id = old.approval_request_id
          and request.organization_id = old.organization_id
        for share;

        if found then
          recipient_still_eligible := case old.event_type
            when 'review_requested' then
              approval_request.status = 'awaiting_approval'
              and approval_request.version = old.approval_request_version
              and old.recipient_operator_id <>
                approval_request.requester_operator_id
              and current_recipient_role in ('owner', 'admin')
            when 'approval_approved' then
              approval_request.status = 'approved'
              and approval_request.version >= old.approval_request_version
              and old.recipient_operator_id =
                approval_request.requester_operator_id
            when 'approval_changes_requested' then
              approval_request.status = 'changes_requested'
              and approval_request.version = old.approval_request_version
              and old.recipient_operator_id =
                approval_request.requester_operator_id
            when 'approval_cancelled' then
              approval_request.status = 'cancelled'
              and approval_request.version = old.approval_request_version
              and old.recipient_operator_id =
                approval_request.requester_operator_id
              and approval_request.decision_operator_id is not null
              and approval_request.decision_operator_id <>
                approval_request.requester_operator_id
            else false
          end;
        end if;
      end if;

      if recipient_still_eligible then
        raise exception
          'An eligible recipient notification cannot be cancelled';
      end if;
    else
      raise exception 'Unsupported notification cancellation code';
    end if;

    new.next_attempt_at := null;
    new.claim_id := null;
    new.claimed_at := null;
    new.claim_expires_at := null;
    new.cancelled_at := database_now;
  elsif old.status = 'provider_accepted'
    and new.status = 'provider_accepted' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type <> 'email.delivery_delayed'
      or new.provider_event_at is null
      or (
        old.provider_event_at is not null
        and new.provider_event_at < old.provider_event_at
      )
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'Provider-accepted updates permit only ordered delayed events';
    end if;
  elsif old.status = 'provider_accepted'
    and new.status in (
      'delivered',
      'bounced',
      'complained',
      'suppressed'
    ) then
    expected_provider_event_type := case new.status
      when 'delivered' then 'email.delivered'
      when 'bounced' then 'email.bounced'
      when 'complained' then 'email.complained'
      when 'suppressed' then 'email.suppressed'
    end;

    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type <> expected_provider_event_type
      or new.provider_event_at is null
      or (
        old.provider_event_at is not null
        and new.provider_event_at < old.provider_event_at
      )
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'Provider webhook does not match the requested terminal state';
    end if;
  elsif old.status = 'provider_accepted'
    and new.status = 'permanent_failure' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is null
      or new.cancellation_code is distinct from old.cancellation_code
      or not (
        (
          new.provider_event_type = 'email.failed'
          and new.provider_event_at is not null
          and (
            old.provider_event_at is null
            or new.provider_event_at >= old.provider_event_at
          )
        )
        or (
          new.last_failure_code = 'delivery_confirmation_missing'
          and new.provider_event_type is not distinct from
            old.provider_event_type
          and new.provider_event_at is not distinct from old.provider_event_at
        )
      ) then
      raise exception
        'Permanent provider failure requires a failed event or missing confirmation';
    end if;

    new.last_failed_at := database_now;
  elsif old.status = 'permanent_failure'
    and old.last_failure_code = 'delivery_confirmation_missing'
    and old.provider_message_id is not null
    and new.status in (
      'delivered',
      'bounced',
      'complained',
      'suppressed'
    ) then
    expected_provider_event_type := case new.status
      when 'delivered' then 'email.delivered'
      when 'bounced' then 'email.bounced'
      when 'complained' then 'email.complained'
      when 'suppressed' then 'email.suppressed'
    end;

    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type <> expected_provider_event_type
      or new.provider_event_at is null
      or (
        old.provider_event_at is not null
        and new.provider_event_at < old.provider_event_at
      )
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'A missing-confirmation failure permits only a signed terminal event';
    end if;

    -- The timeout was provisional. A later signed terminal event is the
    -- authoritative provider outcome, even when its provider timestamp
    -- predates the local provider-acceptance transaction.
    new.last_failure_code := null;
    new.last_failed_at := null;
  elsif old.status = 'permanent_failure'
    and old.last_failure_code = 'delivery_confirmation_missing'
    and old.provider_message_id is not null
    and new.status = 'permanent_failure' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code <> 'provider_rejected'
      or new.provider_event_type <> 'email.failed'
      or new.provider_event_at is null
      or (
        old.provider_event_at is not null
        and new.provider_event_at < old.provider_event_at
      )
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'A missing-confirmation failure permits only a signed failed event';
    end if;

    new.last_failed_at := database_now;
  elsif old.status = 'delivered'
    and new.status = 'complained' then
    if new.claim_id is distinct from old.claim_id
      or new.provider_message_id is distinct from old.provider_message_id
      or new.last_failure_code is distinct from old.last_failure_code
      or new.provider_event_type <> 'email.complained'
      or new.provider_event_at is null
      or new.provider_event_at < old.provider_event_at
      or new.cancellation_code is distinct from old.cancellation_code then
      raise exception
        'Delivered notifications may advance only to a later complaint';
    end if;
  else
    raise exception 'Approval notification lifecycle transition is not allowed';
  end if;

  new.updated_at := greatest(old.updated_at, database_now);
  return new;
end
$maintainflow_approval_notification_delivery$;

create trigger maintainflow_approval_notification_delivery_guard
before insert or update
on public.maintainflow_approval_notification_deliveries
for each row execute function
  public.maintainflow_enforce_approval_notification_delivery();

revoke all privileges on function
  public.maintainflow_enforce_approval_notification_delivery()
from public;

do $maintainflow_revoke_approval_notification_function_roles$
declare
  target_role text;
begin
  foreach target_role in array array[
    'anon',
    'authenticated',
    'service_role',
    'maintainflow_app'
  ]
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = target_role
    ) then
      execute format(
        'revoke all privileges on function public.maintainflow_enforce_approval_notification_delivery() from %I',
        target_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_approval_notification_function_roles$;

alter table public.maintainflow_approval_notification_deliveries
  enable row level security;

revoke all privileges on table
  public.maintainflow_approval_notification_deliveries
from public;

do $maintainflow_revoke_approval_notification_data_api_roles$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = api_role
    ) then
      execute format(
        'revoke all privileges on table public.maintainflow_approval_notification_deliveries from %I',
        api_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_approval_notification_data_api_roles$;

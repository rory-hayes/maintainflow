create table if not exists maintainflow_creative_review_state (
  advertiser_account_id uuid not null
    references maintainflow_advertiser_accounts(id) on delete cascade,
  ad_id text not null,
  ad_group_id text not null,
  ad_name text not null,
  review_status text not null
    check (review_status in ('in_review', 'rejected', 'approved')),
  delivery_status text not null
    check (delivery_status in ('active', 'paused', 'archived')),
  provider_updated_at bigint not null check (provider_updated_at >= 0),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (advertiser_account_id, ad_id)
);

create table if not exists maintainflow_creative_review_events (
  id uuid primary key,
  advertiser_account_id uuid not null
    references maintainflow_advertiser_accounts(id) on delete cascade,
  ad_id text not null,
  ad_group_id text not null,
  ad_name text not null,
  event_type text not null check (
    event_type in (
      'review_status_changed',
      'delivery_status_changed',
      'review_and_delivery_changed'
    )
  ),
  previous_review_status text not null
    check (previous_review_status in ('in_review', 'rejected', 'approved')),
  review_status text not null
    check (review_status in ('in_review', 'rejected', 'approved')),
  previous_delivery_status text not null
    check (previous_delivery_status in ('active', 'paused', 'archived')),
  delivery_status text not null
    check (delivery_status in ('active', 'paused', 'archived')),
  provider_updated_at bigint not null check (provider_updated_at >= 0),
  detected_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists maintainflow_creative_review_event_dedupe_idx
  on maintainflow_creative_review_events (
    advertiser_account_id,
    ad_id,
    provider_updated_at,
    review_status,
    delivery_status
  );

create index if not exists maintainflow_creative_review_events_account_detected_idx
  on maintainflow_creative_review_events (
    advertiser_account_id,
    detected_at desc,
    id
  );

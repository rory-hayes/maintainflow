create table if not exists maintainflow_rate_limit_buckets (
  scope text not null check (scope in ('readiness_ip', 'readiness_host')),
  subject_hash text not null check (length(subject_hash) = 64),
  window_started_at timestamptz not null,
  request_count integer not null check (
    request_count >= 1 and request_count <= 1000
  ),
  updated_at timestamptz not null default now(),
  primary key (scope, subject_hash)
);

create index if not exists maintainflow_rate_limit_buckets_window_idx
  on maintainflow_rate_limit_buckets (window_started_at);

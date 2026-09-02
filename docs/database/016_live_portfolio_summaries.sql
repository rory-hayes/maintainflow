alter table maintainflow_live_workbench_snapshots
  add column if not exists detected_signal_count integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'maintainflow_live_snapshot_signal_count_check'
      and conrelid =
        'public.maintainflow_live_workbench_snapshots'::regclass
      and contype = 'c'
  ) then
    alter table maintainflow_live_workbench_snapshots
      add constraint maintainflow_live_snapshot_signal_count_check
      check (
        detected_signal_count is null
        or detected_signal_count between 0 and 1000000
      );
  end if;
end
$$;

comment on column maintainflow_live_workbench_snapshots.detected_signal_count is
  'Bounded recommendation count written only with a schema-validated snapshot; null means unknown until refreshed.';

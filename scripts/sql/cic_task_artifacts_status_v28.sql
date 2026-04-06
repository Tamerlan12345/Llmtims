alter table public.task_artifacts
    add column if not exists status text not null default 'ready';

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'task_artifacts_status_check'
    ) then
        alter table public.task_artifacts
            add constraint task_artifacts_status_check
            check (status in ('ready', 'processing', 'failed'));
    end if;
end $$;

create index if not exists idx_task_artifacts_office_status_created
    on public.task_artifacts(office_id, status, created_at desc);

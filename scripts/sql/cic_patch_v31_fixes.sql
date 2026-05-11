-- Patch v31: fixes for task_artifacts table, tasks archived status,
-- and task_artifacts status column.

-- 1. Ensure task_artifacts table exists (safe re-run)
create table if not exists public.task_artifacts (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.tasks(id) on delete cascade,
    office_id uuid not null references public.offices(id) on delete cascade,
    role text,
    skill_name text,
    artifact_type text not null default 'file',
    title text not null,
    storage_bucket text not null default 'office-artifacts',
    storage_path text not null,
    mime_type text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint task_artifacts_title_nonempty_chk check (char_length(trim(title)) between 1 and 240),
    constraint task_artifacts_path_nonempty_chk check (char_length(trim(storage_path)) > 0)
);

create index if not exists idx_task_artifacts_task_created
    on public.task_artifacts(task_id, created_at desc);

create index if not exists idx_task_artifacts_office_created
    on public.task_artifacts(office_id, created_at desc);

-- 2. Add status column to task_artifacts if missing
alter table public.task_artifacts
    add column if not exists status text not null default 'ready';

-- 3. Add task_artifacts_status_check constraint if missing
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'task_artifacts_status_check'
    ) then
        alter table public.task_artifacts
            add constraint task_artifacts_status_check
            check (status in ('ready', 'processing', 'failed'));
    end if;
end $$;

create index if not exists idx_task_artifacts_office_status_created
    on public.task_artifacts(office_id, status, created_at desc);

-- 4. Enable RLS on task_artifacts
alter table public.task_artifacts enable row level security;

-- 5. Service-role-only RLS policy for task_artifacts (consistent with v30 hardening)
drop policy if exists "Office access on task_artifacts" on public.task_artifacts;
drop policy if exists "Service role only task_artifacts" on public.task_artifacts;

create policy "Service role only task_artifacts"
on public.task_artifacts for all
using (false)
with check (false);

-- 6. Add 'archived' to tasks status constraint
-- Drop old constraint first, then recreate permissively.
do $$
begin
    if exists (
        select 1 from pg_constraint where conname = 'tasks_status_check'
    ) then
        alter table public.tasks drop constraint tasks_status_check;
    end if;
end $$;

-- Update any legacy status values that would violate the new constraint
update public.tasks
set status = 'pending'
where status is not null
  and status not in (
    'pending', 'in_progress', 'done', 'waiting_human',
    'waiting_approval', 'approved', 'rejected', 'cancelled',
    'archived', 'failed', 'idle'
  );

-- Add updated constraint that includes 'archived' and all known statuses
alter table public.tasks
    add constraint tasks_status_check
    check (status in (
        'pending', 'in_progress', 'done', 'waiting_human',
        'waiting_approval', 'approved', 'rejected', 'cancelled',
        'archived', 'failed', 'idle'
    ));

-- 7. Ensure office-artifacts storage bucket exists
insert into storage.buckets (id, name, public)
values ('office-artifacts', 'office-artifacts', false)
on conflict (id) do nothing;

-- 8. Reload PostgREST schema cache
do $$
begin
    perform pg_notify('pgrst', 'reload schema');
exception when others then null;
end $$;

create extension if not exists pgcrypto with schema extensions;

alter table public.tasks
    add column if not exists current_assignee text;

create index if not exists idx_tasks_office_status_assignee_updated
    on public.tasks(office_id, status, current_assignee, updated_at desc);

update public.tasks t
set current_assignee = wc.current_assignee
from public.workflow_checkpoints wc
where t.id = wc.task_id
  and t.current_assignee is null
  and wc.current_assignee is not null;

create table if not exists public.langgraph_checkpoints (
    thread_id uuid primary key references public.tasks(id) on delete cascade,
    task_id uuid not null references public.tasks(id) on delete cascade,
    office_id uuid references public.offices(id) on delete cascade,
    checkpoint jsonb not null default '{}'::jsonb,
    metadata jsonb not null default '{}'::jsonb,
    step_index bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint langgraph_checkpoints_task_match_chk check (thread_id = task_id)
);

create index if not exists idx_langgraph_checkpoints_office_updated
    on public.langgraph_checkpoints(office_id, updated_at desc);

create index if not exists idx_langgraph_checkpoints_task_step
    on public.langgraph_checkpoints(task_id, step_index desc);

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

alter table public.langgraph_checkpoints enable row level security;
alter table public.task_artifacts enable row level security;

drop policy if exists "Office access on langgraph_checkpoints" on public.langgraph_checkpoints;
drop policy if exists "Office access on task_artifacts" on public.task_artifacts;

create policy "Office access on langgraph_checkpoints"
on public.langgraph_checkpoints for all
using (office_id is null or public.has_office_access(office_id));

create policy "Office access on task_artifacts"
on public.task_artifacts for all
using (public.has_office_access(office_id));

insert into storage.buckets (id, name, public)
values ('office-artifacts', 'office-artifacts', false)
on conflict (id) do update
set public = excluded.public,
    name = excluded.name;

drop policy if exists "Office artifacts read" on storage.objects;
drop policy if exists "Office artifacts write" on storage.objects;
drop policy if exists "Office artifacts update" on storage.objects;
drop policy if exists "Office artifacts delete" on storage.objects;

create policy "Office artifacts read"
on storage.objects for select
using (
    bucket_id = 'office-artifacts'
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$'
    and public.has_office_access(((storage.foldername(name))[1])::uuid)
);

create policy "Office artifacts write"
on storage.objects for insert
with check (
    bucket_id = 'office-artifacts'
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$'
    and public.has_office_access(((storage.foldername(name))[1])::uuid)
);

create policy "Office artifacts update"
on storage.objects for update
using (
    bucket_id = 'office-artifacts'
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$'
    and public.has_office_access(((storage.foldername(name))[1])::uuid)
)
with check (
    bucket_id = 'office-artifacts'
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$'
    and public.has_office_access(((storage.foldername(name))[1])::uuid)
);

create policy "Office artifacts delete"
on storage.objects for delete
using (
    bucket_id = 'office-artifacts'
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$'
    and public.has_office_access(((storage.foldername(name))[1])::uuid)
);

do $$
begin
    perform pg_notify('pgrst', 'reload schema');
exception
    when others then
        null;
end
$$;


create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sub_tasks (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.tasks(id) on delete cascade,
    office_id uuid not null references public.offices(id) on delete cascade,
    thread_id uuid references public.chat_threads(id) on delete set null,
    assignee_role text not null,
    assignee_agent_id uuid references public.agents(id) on delete set null,
    instruction text not null,
    delegated_by_role text,
    status text not null default 'pending',
    rework_count integer not null default 0,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint sub_tasks_status_check check (status in ('pending', 'in_progress', 'done', 'waiting_human')),
    constraint sub_tasks_instruction_nonempty_check check (char_length(trim(instruction)) > 0),
    constraint sub_tasks_rework_count_nonnegative_check check (rework_count >= 0)
);

create index if not exists idx_sub_tasks_task_updated
    on public.sub_tasks(task_id, updated_at desc);

create index if not exists idx_sub_tasks_office_status_updated
    on public.sub_tasks(office_id, status, updated_at desc);

create index if not exists idx_sub_tasks_thread_created
    on public.sub_tasks(thread_id, created_at asc);

alter table public.sub_tasks enable row level security;

drop policy if exists "Admin access on sub_tasks" on public.sub_tasks;

create policy "Admin access on sub_tasks"
on public.sub_tasks for all
using (true);

do $$
begin
    perform pg_notify('pgrst', 'reload schema');
exception
    when others then
        null;
end
$$;

-- Digital Pixel Office v3 schema upgrade
-- Dynamic roles, markdown instructions, and persisted workflow pauses.

create extension if not exists pgcrypto with schema extensions;

alter table public.agents
    add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.agents
    add column if not exists role_md text not null default '';

alter table public.skills_catalog
    add column if not exists instruction_md text not null default '';

alter table public.roles_catalog
    add column if not exists role_markdown text not null default '';

alter table public.roles_catalog
    add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.workflow_checkpoints (
    task_id uuid primary key references public.tasks(id) on delete cascade,
    office_id uuid references public.offices(id) on delete cascade,
    room_key text,
    status text not null default 'running',
    waiting_for_human boolean not null default false,
    current_assignee text,
    state jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_workflow_checkpoints_office_status
    on public.workflow_checkpoints (office_id, status, updated_at desc);

alter table public.workflow_checkpoints enable row level security;

drop policy if exists "Office access on workflow_checkpoints" on public.workflow_checkpoints;

create policy "Office access on workflow_checkpoints"
on public.workflow_checkpoints for all
using (office_id is null or public.has_office_access(office_id));
